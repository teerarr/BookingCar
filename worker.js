// ระบบจองรถบริษัท — Cloudflare Workers + D1

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      // ---------- ผู้ดูแลระบบ ----------
      if (request.method === 'POST' && path === '/api/admin/login')  return adminLogin(request, env);
      if (request.method === 'POST' && path === '/api/admin/logout') return adminLogout();
      if (request.method === 'GET'  && path === '/api/admin/me')
        return json({ admin: await isAdmin(request, env) });

      // ---------- รถ ----------
      if (request.method === 'GET' && path === '/api/cars') return listCars(new URL(request.url), env);
      if (request.method === 'POST' && path === '/api/cars') {
        if (!(await isAdmin(request, env)))
          return json({ error: 'ต้องเข้าสู่ระบบในฐานะผู้ดูแลระบบ (Admin) เพื่อเพิ่มรถ' }, 403);
        return addCar(request, env);
      }

      // ---------- การจอง ----------
      if (request.method === 'GET'  && path === '/api/bookings') return listBookings(new URL(request.url), env);
      if (request.method === 'POST' && path === '/api/bookings') return createBooking(request, env, ctx);

      const m = path.match(/^\/api\/bookings\/(\d+)\/cancel$/);
      if (request.method === 'POST' && m) return cancelBooking(m[1], env, ctx);

      // ---------- แผนก (ข้อมูลหลัก) ----------
      if (request.method === 'GET'  && path === '/api/departments') return listDepartments(env);
      if (request.method === 'POST' && path === '/api/departments') {
        if (!(await isAdmin(request, env)))
          return json({ error: 'ต้องเข้าสู่ระบบในฐานะผู้ดูแลระบบ (Admin) เพื่อจัดการแผนก' }, 403);
        return addDepartment(request, env);
      }
      const dm = path.match(/^\/api\/departments\/(\d+)$/);
      if (dm) {
        if (!(await isAdmin(request, env)))
          return json({ error: 'ต้องเข้าสู่ระบบในฐานะผู้ดูแลระบบ (Admin) เพื่อจัดการแผนก' }, 403);
        if (request.method === 'PUT')    return renameDepartment(dm[1], request, env);
        if (request.method === 'DELETE') return deleteDepartment(dm[1], env);
      }

      // ---------- รายงาน ----------
      if (request.method === 'GET' && path === '/api/report') return report(env);

      return json({ error: 'ไม่พบ API ที่ร้องขอ' }, 404);
    } catch (e) {
      return json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์: ' + e.message }, 500);
    }
  },
};

// ---------- รถ ----------

async function listCars(url, env) {
  const { results: cars } = await env.DB.prepare('SELECT * FROM cars ORDER BY id').all();
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  // ไม่ระบุช่วงเวลา → แสดงรายชื่อรถอย่างเดียว
  if (!start || !end) return json({ cars: cars.map(c => ({ ...c, available: null })) });

  // หารถที่มี booking ค้างในช่วงเวลาที่สอบถาม (เวลาทับซ้อน)
  const { results: busy } = await env.DB.prepare(
    `SELECT car_id, borrower_name, start_time, end_time
     FROM bookings WHERE status = 'active' AND start_time < ? AND end_time > ?`
  ).bind(end, start).all();

  const busyMap = {};
  for (const b of busy) busyMap[b.car_id] = b;

  return json({
    cars: cars.map(c => ({
      ...c,
      available: !busyMap[c.id],
      booked_by: busyMap[c.id]?.borrower_name ?? null,
    })),
  });
}

async function addCar(request, env) {
  const { plate, name, seats } = await request.json();
  if (!plate?.trim() || !name?.trim())
    return json({ error: 'กรุณากรอกทะเบียนรถและรุ่นรถให้ครบ' }, 400);
  try {
    const res = await env.DB.prepare(
      'INSERT INTO cars (plate, name, seats) VALUES (?, ?, ?)'
    ).bind(plate.trim(), name.trim(), seats || 4).run();
    return json({ ok: true, id: res.meta.last_row_id }, 201);
  } catch (e) {
    if (String(e.message).includes('UNIQUE'))
      return json({ error: 'ทะเบียนรถนี้มีอยู่ในระบบแล้ว' }, 409);
    throw e;
  }
}

// ---------- การจอง ----------

async function listBookings(url, env) {
  const status = url.searchParams.get('status');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let sql = `SELECT b.*, c.plate, c.name AS car_name
             FROM bookings b JOIN cars c ON c.id = b.car_id WHERE 1 = 1`;
  const args = [];

  // ช่วงเวลา (สำหรับปฏิทิน): การจองที่เริ่มก่อน "to" และจบหลัง "from"
  if (from && to) {
    sql += ' AND b.start_time < ? AND b.end_time > ?';
    args.push(to, from);
  }
  if (!status) {
    sql += " AND b.status = 'active'";          // ค่าเริ่มต้น: ไม่รวมที่ยกเลิก
  } else if (status !== 'all') {
    sql += ' AND b.status = ?';
    args.push(status);
  }
  sql += ' ORDER BY b.start_time DESC LIMIT 500';

  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ bookings: results });
}
async function createBooking(request, env, ctx) {
  const b = await request.json();
  const carId = Number(b.car_id);
  const name = (b.borrower_name || '').trim();

  if (!carId || !name || !b.start_time || !b.end_time)
    return json({ error: 'กรุณากรอกข้อมูลให้ครบ (รถ, ชื่อผู้จอง, เวลาเริ่ม-สิ้นสุด)' }, 400);

  const start = new Date(b.start_time), end = new Date(b.end_time);
  if (isNaN(start) || isNaN(end)) return json({ error: 'รูปแบบวันเวลาไม่ถูกต้อง' }, 400);
  if (start >= end) return json({ error: 'เวลาสิ้นสุดต้องหลังจากเวลาเริ่มต้น' }, 400);
  if (end < new Date()) return json({ error: 'ไม่สามารถจองช่วงเวลาที่ผ่านไปแล้ว' }, 400);

  const email = (b.borrower_email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' }, 400);

  const car = await env.DB.prepare('SELECT id, plate, name FROM cars WHERE id = ?').bind(carId).first();
  if (!car) return json({ error: 'ไม่พบรถคันนี้ในระบบ' }, 404);

  const dept = (b.department || '').trim();
  if (dept) {
    const found = await env.DB.prepare('SELECT id FROM departments WHERE name = ?').bind(dept).first();
    if (!found)
      return json({ error: 'แผนก "' + dept + '" ไม่อยู่ในรายการ กรุณาเลือกจากรายการ หรือติดต่อผู้ดูแลระบบ' }, 400);
  }

  const sISO = start.toISOString(), eISO = end.toISOString();

  const clash = await env.DB.prepare(
    `SELECT borrower_name FROM bookings
     WHERE car_id = ? AND status = 'active' AND start_time < ? AND end_time > ? LIMIT 1`
  ).bind(carId, eISO, sISO).first();

  if (clash)
    return json({ error: `รถคันนี้ถูกจองแล้วโดย ${clash.borrower_name} ในช่วงเวลาที่ทับซ้อนกัน` }, 409);

  const res = await env.DB.prepare(
    `INSERT INTO bookings (car_id, borrower_name, borrower_email, department, destination, purpose, start_time, end_time)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE car_id = ? AND status = 'active' AND start_time < ? AND end_time > ?
     )`
  ).bind(carId, name, email, dept, b.destination || '', b.purpose || '', sISO, eISO,
         carId, eISO, sISO).run();

  if (res.meta.changes === 0)
    return json({ error: 'รถคันนี้เพิ่งถูกจองไปก่อนหน้านี้ไม่กี่วินาที กรุณาตรวจสอบแล้วจองใหม่' }, 409);

  // ส่งอีเมลยืนยันแบบไม่บล็อก — ส่งไม่สำเร็จก็ไม่กระทบการจอง
  if (ctx) ctx.waitUntil(notifyBooking(env, {
    kind: 'booked', name, dept, email,
    plate: car.plate, carName: car.name,
    start: sISO, end: eISO,
    destination: b.destination || '', purpose: b.purpose || '',
  }));

  return json({ ok: true, id: res.meta.last_row_id }, 201);
}

async function cancelBooking(id, env, ctx) {
  // ดึงข้อมูลก่อน เพื่อเอาไปทำอีเมล
  const b = await env.DB.prepare(
    `SELECT b.*, c.plate, c.name AS car_name
     FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.id = ?`
  ).bind(id).first();
  if (!b) return json({ error: 'ไม่พบรายการจอง หรือยกเลิกไปแล้ว' }, 404);

  const res = await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'active'`
  ).bind(id).run();
  if (res.meta.changes === 0) return json({ error: 'รายการนี้ถูกยกเลิกไปแล้ว' }, 404);

  if (ctx) ctx.waitUntil(notifyBooking(env, {
    kind: 'cancelled', name: b.borrower_name, dept: b.department, email: b.borrower_email,
    plate: b.plate, carName: b.car_name,
    start: b.start_time, end: b.end_time,
    destination: b.destination, purpose: b.purpose,
  }));

  return json({ ok: true });
}
// ---------- รายงานสรุป ----------

async function report(env) {
  const totals = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM cars) AS total_cars,
       COUNT(*) AS total_bookings,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_bookings,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_bookings,
       SUM(CASE WHEN status = 'active' AND julianday(start_time) > julianday('now') THEN 1 ELSE 0 END) AS upcoming_bookings,
       SUM(CASE WHEN status = 'active' AND julianday(start_time) <= julianday('now')
                AND julianday(end_time) >= julianday('now') THEN 1 ELSE 0 END) AS in_use_now
     FROM bookings`
  ).first();

  const perCar = await env.DB.prepare(
    `SELECT c.plate, c.name,
            COUNT(b.id) AS booking_count,
            COALESCE(ROUND(SUM((julianday(b.end_time) - julianday(b.start_time)) * 24), 1), 0) AS total_hours
     FROM cars c
     LEFT JOIN bookings b ON b.car_id = c.id AND b.status = 'active'
     GROUP BY c.id ORDER BY booking_count DESC, c.id`
  ).all();

  const perPerson = await env.DB.prepare(
    `SELECT borrower_name, MAX(department) AS department, COUNT(*) AS booking_count,
            COALESCE(ROUND(SUM((julianday(end_time) - julianday(start_time)) * 24), 1), 0) AS total_hours
     FROM bookings WHERE status = 'active'
     GROUP BY borrower_name ORDER BY booking_count DESC LIMIT 10`
  ).all();

  return json({ totals, perCar: perCar.results, perPerson: perPerson.results });
}

// ---------- อีเมลแจ้งเตือน (Resend) ----------

async function notifyBooking(env, b) {
  try {
    if (!env.RESEND_API_KEY) return;   // ยังไม่ได้ตั้งค่า → ข้ามการส่ง
    const recipients = [...new Set([b.email, env.NOTIFY_EMAIL].filter(Boolean))];
    if (!recipients.length) return;

    const booked = b.kind === 'booked';
    const thDate = iso => new Date(iso).toLocaleString('th-TH', { dateStyle: 'full', timeStyle: 'short' });
    const subject = (booked ? 'ยืนยันการจองรถ ' : 'ยกเลิกการจองรถ ') + b.plate +
      ' — ' + new Date(b.start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });

    const row = (l, v) =>
      '<tr><td style="padding:8px 14px;background:#f8fafc;font-size:13px;color:#64748b;white-space:nowrap">' + l + '</td>' +
      '<td style="padding:8px 14px;font-size:14px;color:#0f172a">' + (v ? '<b>' + v + '</b>' : '-') + '</td></tr>';

    const html =
      '<div style="font-family:Tahoma,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">' +
        '<div style="background:' + (booked ? '#16a34a' : '#dc2626') + ';color:#fff;padding:16px 20px;font-size:17px;font-weight:bold">' +
          (booked ? 'ยืนยันการจองรถสำเร็จ' : 'มีการยกเลิกการจองรถ') +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse">' +
          row('ผู้จอง', b.name) +
          row('แผนก', b.dept) +
          row('รถ', b.plate + ' (' + b.carName + ')') +
          row('ช่วงเวลา', thDate(b.start) + ' น. ถึง ' + thDate(b.end) + ' น.') +
          row('ปลายทาง', b.destination) +
          row('วัตถุประสงค์', b.purpose) +
        '</table>' +
        '<div style="padding:12px 20px;font-size:12px;color:#94a3b8">อีเมลนี้ส่งอัตโนมัติจากระบบจองรถบริษัท กรุณาอย่าตอบกลับ</div>' +
      '</div>';

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Car Booking <onboarding@resend.dev>',
        to: recipients,
        subject, html,
      }),
    });
  } catch (e) {
    // ส่งอีเมลล้มเหลว → ไม่กระทบผลลัพธ์หลักของ API
  }
}