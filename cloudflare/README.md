# คู่มือติดตั้งและเชื่อมต่อ Cloudflare D1

แอปติดต่อฐานข้อมูลผ่าน Cloudflare Worker ไม่ได้เชื่อมต่อ D1 โดยตรง คู่มือนี้เหมาะสำหรับผู้ดูแลระบบที่มีบัญชี Cloudflare และเตรียมฐานข้อมูลของแอปไว้แล้ว

## สำหรับผู้ใช้งานแอป

หากผู้ดูแลระบบ deploy Worker และตั้งค่าบัญชีให้แล้ว:

1. เปิดแอป แล้วเลือก **Cloudflare D1 (Worker)** ในช่องผู้ให้บริการฐานข้อมูล
2. วาง URL หลักของ Worker เช่น `https://ชื่อ-worker.ชื่อบัญชี.workers.dev` ห้ามเติม `/query` หรือ `/api`
3. กด **เชื่อมต่อ** แล้วเข้าสู่ระบบด้วยอีเมลและรหัสผ่านบัญชีที่ผู้ดูแลระบบสร้างไว้

URL ของ Worker ดูได้ที่ Cloudflare Dashboard → **Workers & Pages** → เลือก Worker → **Settings** หรือ **Overview** ทั้งนี้ URL จะแสดงหลัง deploy สำเร็จ

## สำหรับผู้ดูแลระบบ: ติดตั้งหรือ deploy Worker

### สิ่งที่ต้องมี

- Node.js และ npm
- บัญชี Cloudflare ที่เข้าถึง Worker และ D1 ได้
- ฐานข้อมูล D1 ที่มีตารางของแอป เช่น `Employees`, `Products`, `Statements`, `Accounting`, `Creditors`, `CreditorMoves`, `Types`, `Due`, `Operations` และ `Config`

> การสร้าง D1 เปล่าอย่างเดียวไม่เพียงพอ เพราะไฟล์ `schema.sql` ในโครงการนี้สร้างเฉพาะตาราง `PawnAuth` ไม่ได้สร้างตารางธุรกิจทั้งหมด ควรใช้ D1 ที่เตรียมตารางแอปไว้แล้ว

### 1. ติดตั้ง Wrangler และเข้าสู่ระบบ

เปิด PowerShell ในโฟลเดอร์โครงการ:

```powershell
npm install --global wrangler
wrangler login
```

ทำตามหน้าต่างเบราว์เซอร์เพื่ออนุญาต Wrangler ให้เข้าถึงบัญชี Cloudflare

### 2. ตรวจสอบการตั้งค่า D1

เปิด `cloudflare/wrangler.toml` แล้วตรวจสอบชื่อ Worker, ชื่อฐานข้อมูล และ `database_id` ให้ตรงกับบัญชีของคุณ:

```toml
name = "pawnshop-api"
main = "worker.js"

[[d1_databases]]
binding = "DB"
database_name = "pawnshop"
database_id = "ใส่ D1 database ID ของคุณ"
```

หา Database ID ได้จาก Cloudflare Dashboard → **Workers & Pages** → **D1 SQL database** → เลือกฐานข้อมูล ค่าของ `binding` ต้องเป็น `DB` ตามที่ Worker ใช้งาน

### 3. เตรียมตารางการยืนยันตัวตน

คำสั่งนี้เพิ่มตาราง `PawnAuth` สำหรับ session และ rate limit โดยไม่ลบหรือสร้างตารางธุรกิจใหม่:

```powershell
wrangler d1 execute pawnshop --remote --file=cloudflare/schema.sql --config cloudflare/wrangler.toml
```

### 4. สร้างและ deploy Worker

จากโฟลเดอร์หลักของโครงการ รัน:

```powershell
node scripts/build-cloudflare.js
wrangler deploy --config cloudflare/wrangler.toml
```

จด URL ที่ Wrangler แสดงหลัง deploy แล้วลองเชื่อมต่อผ่านแอปตามหัวข้อแรก Worker นี้ให้บริการ API ของแอปที่ URL หลัก และปิด endpoint `/query` สำหรับสั่ง SQL โดยตรง

### 5. ตั้งค่าบัญชีผู้ดูแลครั้งแรก

Worker ต้องมีตารางแอปครบก่อนตั้งค่าบัญชี ถ้าฐานข้อมูลยังไม่มีผู้ใช้ ผู้ดูแลระบบต้องกำหนด Worker secret ชื่อ `SETUP_SECRET` และเรียก endpoint `/setup` ด้วย secret นี้ พร้อมชื่อ อีเมล และรหัสผ่านผู้ดูแลที่ยาวอย่างน้อย 8 ตัวอักษร ดูรายละเอียด request ได้จากฟังก์ชัน `__setup` ใน `cloudflare/worker-template.js`

เก็บ secret และรหัสผ่านไว้อย่างปลอดภัย ห้ามฝังไว้ในหน้าเว็บหรือส่งให้ผู้ใช้ทั่วไป เมื่อมีบัญชีในตาราง `Employees` แล้ว `/setup` จะปฏิเสธการตั้งค่าซ้ำ และไม่ควรลบข้อมูลผู้ใช้เพื่อเรียก setup ใหม่

## ข้อควรระวัง

- ตรวจสอบ Worker และ D1 ปลายทางให้ถูกต้องก่อนเชื่อมต่อ เพราะข้อมูลจริงจะบันทึกในฐานข้อมูลที่ Worker ผูกไว้
- ถ้าฐานข้อมูลมีข้อมูลเดิมอยู่แล้ว อย่ารัน setup ซ้ำ และอย่าใช้คำสั่งลบหรือสร้างตารางทับข้อมูล
- ใช้ URL แบบ HTTPS เท่านั้น เก็บ `SETUP_SECRET` ใน Cloudflare Worker secret ไม่ใส่ในโค้ดหน้าเว็บหรือ repository
- หลังแก้ `worker-template.js` ให้รัน build และ deploy ใหม่ เพื่อให้ Worker ใช้โค้ดฉบับล่าสุด
- สำรองข้อมูล D1 ก่อนทำการเปลี่ยนแปลงฐานข้อมูลสำคัญ
