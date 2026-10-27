# 1. ติดตั้ง wrangler และเข้าสู่ระบบ Cloudflare
npx wrangler login

# 2. สร้างฐานข้อมูล D1
npx wrangler d1 create car-booking-db
# → คัดลอก database_id ที่ได้ ไปแทนค่าใน wrangler.toml

# 3. สร้างตารางในฐานข้อมูลจริง (บนคลาวด์)
npx wrangler d1 execute car-booking-db --remote --file=./schema.sql

# 4. ทดสอบบนเครื่องตัวเอง (optional)
npx wrangler d1 execute car-booking-db --local --file=./schema.sql
npx wrangler dev

# 5. deploy ขึ้น production
npx wrangler deploy