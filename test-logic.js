/* Unit tests สำหรับ logic.js + pbkdf2.js (รันด้วย node) */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const LOGIC_EXPORTS = 'calInterest, calEndDate, getCountInterest, dateDiffDays, dateParse, dateFmt, todayStr, dateDriff, cashInOf, cashOutOf, sanitizeCell, isFormulaLike, toIntBaht, fmtBaht'
const PBKDF2_EXPORTS = 'sha256Bytes, strBytes, bytesHex, hmacSha256, pbkdf2Sha256, hashPassword'
function load(f, exportsList) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
  const mod = { exports: {} }
  const fn = new Function('module', 'exports', src + '\n;module.exports = { ' + exportsList + ' }')
  fn(mod, mod.exports)
  return mod.exports
}
const L = load('js/logic.js', LOGIC_EXPORTS)
Object.assign(L, load('js/pbkdf2.js', PBKDF2_EXPORTS))

let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w) }
}

console.log('== calInterest (ตรงต้นฉบับ) ==')
eq('price 1000 -> 50', L.calInterest(1000), 50)
eq('price 1100 -> 60 (advisor case)', L.calInterest(1100), 60)
eq('price 2000 -> 100', L.calInterest(2000), 100)
eq('price 500 -> 25+5=30', L.calInterest(500), 30)
eq('price 3000 -> 150', L.calInterest(3000), 150)
eq('price 11000 -> 550 (เป็นสิบเต็มอยู่แล้ว)', L.calInterest(11000), 550)

console.log('== calEndDate ==')
eq('due 30 = +1 เดือน (31 ม.ค. -> 28 ก.พ. หรือ 29 ปีอธิกสุรทิน)', L.calEndDate(30, '2024-01-31'), '2024-02-29')
eq('due 30 ปกติ', L.calEndDate(30, '2026-10-24'), '2026-11-24')
eq('due 15 = +15 วัน', L.calEndDate(15, '2026-10-24'), '2026-11-08')
eq('due 10 = +10 วัน', L.calEndDate(10, '2026-10-24'), '2026-11-03')
eq('due 0 = 0 (ขายสินค้า)', L.calEndDate(0, '2026-10-24'), 0)
eq('ปลายเดือน 31 ต.ค. +1 เดือน -> 30 พ.ย.', L.calEndDate(30, '2026-10-31'), '2026-11-30')

console.log('== dateDiffDays ==')
eq('diff พ.ย.2 - ต.ค.24 = 9', L.dateDiffDays('2026-11-02', '2026-10-24'), 9)
eq('diff ย้อนหลัง = -9', L.dateDiffDays('2026-10-24', '2026-11-02'), -9)

console.log('== getCountInterest (นับงวดค้าง) ==')
// endDate 2026-09-01, due 30, วันนี้ 2026-10-24 -> เกิน 53 วัน -> ceil(53/30)=2 งวด
const today = L.todayStr()
console.log('  (วันนี้ = ' + today + ')')
const daysOver = L.dateDiffDays(today, '2026-09-01')
eq('งวดค้าง (คำนวณจากวันนี้)', L.getCountInterest('2026-01-01', '2026-09-01', 30), Math.max(0, Math.ceil(daysOver / 30)))
eq('due 0 -> 0 งวด', L.getCountInterest('2026-01-01', '2026-09-01', 0), 0)

console.log('== การเงิน statement ==')
eq('cashIn ของไถ่ถอน (income=1000, profit=50) = 1050', L.cashInOf({ income: 1000, profit: 50 }), 1050)
eq('cashOut ของรับจำใหม่ (pay=1000) = 1000', L.cashOutOf({ pay: 1000 }), 1000)

console.log('== ป้องกัน formula injection ==')
eq('เติม =SUM(A1)', L.sanitizeCell('=SUM(A1)'), "'=SUM(A1)")
eq('ข้อความปกติผ่าน', L.sanitizeCell('สร้อยคอทอง'), 'สร้อยคอทอง')

console.log('== toIntBaht ==')
eq('"1000" -> 1000', L.toIntBaht('1000'), 1000)
eq('100.5 -> null (ไม่ใช่จำนวนเต็ม)', L.toIntBaht(100.5), null)
eq('-50 -> null (ต้องไม่ติดลบ)', L.toIntBaht(-50), null)

console.log('== SHA-256 / HMAC / PBKDF2 (เทียบ test vectors มาตรฐาน) ==')
eq('sha256("") เทียบ node crypto', L.bytesHex(L.sha256Bytes(L.strBytes(''))), crypto.createHash('sha256').update('').digest('hex'))
eq('sha256("abc") เทียบ node crypto', L.bytesHex(L.sha256Bytes(L.strBytes('abc'))), crypto.createHash('sha256').update('abc').digest('hex'))
eq('hmac เทียบ node crypto', L.bytesHex(L.hmacSha256(L.strBytes('key'), L.strBytes('data'))), crypto.createHmac('sha256', 'key').update('data').digest('hex'))
eq('hmac คีย์ยาว >64B เทียบ node', L.bytesHex(L.hmacSha256(L.strBytes('k'.repeat(100)), L.strBytes('data'))), crypto.createHmac('sha256', 'k'.repeat(100)).update('data').digest('hex'))
eq('pbkdf2 c=1 (มาตรฐาน)', L.bytesHex(L.pbkdf2Sha256('password', L.strBytes('salt'), 1, 32)), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b')
eq('pbkdf2 c=2 (ตรวจกับ node crypto)', L.bytesHex(L.pbkdf2Sha256('password', L.strBytes('salt'), 2, 32)), 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43')
eq('pbkdf2 c=4096 (ตรวจกับ node crypto)', L.bytesHex(L.pbkdf2Sha256('password', L.strBytes('salt'), 4096, 32)), 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a')
eq('pbkdf2 c=10000 เทียบ node crypto', L.bytesHex(L.pbkdf2Sha256('p@ssสร้อยคอ', L.strBytes('somesalt123'), 10000, 32)), crypto.pbkdf2Sync('p@ssสร้อยคอ', 'somesalt123', 10000, 32, 'sha256').toString('hex'))
eq('hashPassword ใช้ salt hex ถูกต้อง', L.hashPassword('pw', '00112233445566778899aabbccddeeff', 10000), crypto.pbkdf2Sync('pw', Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 10000, 32, 'sha256').toString('hex'))

console.log('\nผลลัพธ์: ' + pass + ' ผ่าน, ' + fail + ' พลาด')
process.exit(fail ? 1 : 0)
