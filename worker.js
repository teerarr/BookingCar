// ระบบจองรถบริษัท — Cloudflare Workers + D1

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // path ที่ไม่ใช่ /api/* → ส่งไปที่ไฟล์ static (public/)
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (request.method === 'GET'  && path === '/api/cars')     return listCars(new URL(request.url), env);
      if (request.method === 'POST' && path === '/api/cars')     return addCar(request, env);
      if (request.method === 'GET'  && path === '/api/bookings') return listBookings(new URL(request.url), env);
      if (request.method === 'POST' && path === '/api/bookings') return createBooking(request, env);

      const m = path.match(/^\/api\/bookings\/(\d+)\/cancel$/);
      if (request.method === 'POST' && m) return cancelBooking(m[1], env);

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
  let sql = `SELECT b.*, c.plate, c.name AS car_name
             FROM bookings b JOIN cars c ON c.id = b.car_id`;
  const args = [];
  if (status && status !== 'all') { sql += ' WHERE b.status = ?'; args.push(status); }
  sql += ' ORDER BY b.start_time DESC LIMIT 500';
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ bookings: results });
}

async function createBooking(request, env) {
  const b = await request.json();
  const carId = Number(b.car_id);
  const name = (b.borrower_name || '').trim();

  if (!carId || !name || !b.start_time || !b.end_time)
    return json({ error: 'กรุณากรอกข้อมูลให้ครบ (รถ, ชื่อผู้จอง, เวลาเริ่ม-สิ้นสุด)' }, 400);

  const start = new Date(b.start_time), end = new Date(b.end_time);
  if (isNaN(start) || isNaN(end)) return json({ error: 'รูปแบบวันเวลาไม่ถูกต้อง' }, 400);
  if (start >= end) return json({ error: 'เวลาสิ้นสุดต้องหลังจากเวลาเริ่มต้น' }, 400);
  if (end < new Date()) return json({ error: 'ไม่สามารถจองช่วงเวลาที่ผ่านไปแล้ว' }, 400);

  const car = await env.DB.prepare('SELECT id FROM cars WHERE id = ?').bind(carId).first();
  if (!car) return json({ error: 'ไม่พบรถคันนี้ในระบบ' }, 404);

  const sISO = start.toISOString(), eISO = end.toISOString();

  // 1) ตรวจล่วงหน้า เพื่อแจ้งชื่อคนที่จองไปแล้ว
  const clash = await env.DB.prepare(
    `SELECT borrower_name FROM bookings
     WHERE car_id = ? AND status = 'active' AND start_time < ? AND end_time > ? LIMIT 1`
  ).bind(carId, eISO, sISO).first();

  if (clash)
    return json({ error: `รถคันนี้ถูกจองแล้วโดย ${clash.borrower_name} ในช่วงเวลาที่ทับซ้อนกัน` }, 409);

  // 2) INSERT แบบมีเงื่อนไข — กัน race condition คนจองพร้อมกัน
  const res = await env.DB.prepare(
    `INSERT INTO bookings (car_id, borrower_name, department, destination, purpose, start_time, end_time)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE car_id = ? AND status = 'active' AND start_time < ? AND end_time > ?
     )`
  ).bind(carId, name, b.department || '', b.destination || '', b.purpose || '', sISO, eISO,
         carId, eISO, sISO).run();

  if (res.meta.changes === 0)
    return json({ error: 'รถคันนี้เพิ่งถูกจองไปก่อนหน้านี้ไม่กี่วินาที กรุณาตรวจสอบแล้วจองใหม่' }, 409);

  return json({ ok: true, id: res.meta.last_row_id }, 201);
}

async function cancelBooking(id, env) {
  const res = await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'active'`
  ).bind(id).run();
  if (res.meta.changes === 0) return json({ error: 'ไม่พบรายการจอง หรือยกเลิกไปแล้ว' }, 404);
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