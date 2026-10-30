/* =========================================================
 * logic.js — กติกาธุรกิจ (คัดลอกจากโค้ดเดิม vuedemo อย่างตรงตัว)
 * ใช้ร่วมกันทั้งฝั่ง web app และ Apps Script (Code.gs)
 * ห้ามแก้สูตรโดยไม่ทดสอบ — มี unit tests กำกับไว้
 * ========================================================= */

/* ---------- วันที่ (YYYY-MM-DD strings, ไม่พึ่งไลบรารีภายนอก) ---------- */

function dateParse(s) {
  // รองรับ 'YYYY-MM-DD' และค่า 0/null/'' จากข้อมูลเดิม (endDate = 0)
  if (!s || s === 0) return null
  if (s instanceof Date) return s
  var m = String(s).slice(0, 10).split('-')
  if (m.length !== 3) return null
  var d = new Date(Number(m[0]), Number(m[1]) - 1, Number(m[2]))
  if (isNaN(d.getTime())) return null
  return d
}

function dateFmt(d) {
  if (!d) return ''
  var y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate()
  return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (da < 10 ? '0' + da : da)
}

function todayStr() {
  var n = new Date()
  return dateFmt(n)
}

function dateDiffDays(a, b) {
  // จำนวนวันจาก b ไป a (a - b)
  var x = dateParse(a), y = dateParse(b)
  if (!x || !y) return 0
  return Math.round((x - y) / 86400000)
}

/* ---------- สูตรดอกเบี้ย (ตรงต้นฉบับ: calInterest) ---------- */

function calInterest(price) {
  // ต้นฉบับ: a = price*5/100 ; ถ้า a%10 != 0 ให้ a += 5
  var a = (price * 5) / 100
  if (a % 10 !== 0) a += 5
  return Math.round(a)
}

/* ---------- วันครบกำหนด (ตรงต้นฉบับ: calEndDate) ---------- */

function calEndDate(due, startDate) {
  if (due == 0) return 0
  var s = dateParse(startDate)
  if (!s) return 0
  if (due == 30) {
    // ต้นฉบับ: moment(startDate).add(1,'M') — เพิ่ม 1 เดือนตามปฏิทิน และ clamp ปลายเดือน
    // (31 ม.ค. + 1 เดือน = 28/29 ก.พ. ไม่ใช่ 2/3 มี.ค.)
    var lastDay = new Date(s.getFullYear(), s.getMonth() + 2, 0).getDate()
    var day = Math.min(s.getDate(), lastDay)
    return dateFmt(new Date(s.getFullYear(), s.getMonth() + 1, day))
  }
  var d2 = new Date(s.getFullYear(), s.getMonth(), s.getDate() + Number(due))
  return dateFmt(d2)
}

/* ---------- นับงวดค้างชำระ (ตรงต้นฉบับ: getCountInterest) ---------- */

function getCountInterest(startDate, endDate, due) {
  if (due > 0) {
    var total = 0
    var diff = -dateDriff(endDate, startDate)
    for (var a = 0; a < diff; a += due) total += 1
    return total
  }
  return 0
}

function dateDriff(endDate, startDate) {
  // ตรงต้นฉบับ: ใช้ endDate ถ้า valid มิฉะนั้นใช้ startDate เทียบกับ "วันนี้"
  var pick = dateParse(endDate) ? endDate : startDate
  return dateDiffDays(pick, todayStr())
}

/* ---------- การเงินของรายการ statement ---------- */
// ธรรมชาติของข้อมูลเดิม:
//   income = เงินต้นที่รับกลับเข้าร้าน, pay = เงินที่ร้านจ่ายออก, profit = ดอกเบี้ย/ส่วนต่าง
//   ดังนั้น "เงินสดรับเข้าจริง" ของร้าน = income + profit

function cashInOf(st) {
  return (Number(st.income) || 0) + (Number(st.profit) || 0)
}
function cashOutOf(st) {
  return Number(st.pay) || 0
}

/* ---------- ตรวจค่าที่รับจากผู้ใช้ ---------- */

function isFormulaLike(v) {
  return typeof v === 'string' && /^[=+\-@\r\t]/.test(v)
}

function sanitizeCell(v) {
  if (isFormulaLike(v)) return "'" + v
  return v
}

function toIntBaht(v) {
  var n = Number(v)
  if (!isFinite(n)) return null
  if (n < 0) return null
  if (Math.abs(n - Math.round(n)) > 1e-9) return null // ต้องเป็นจำนวนเต็มบาท
  return Math.round(n)
}

/* ---------- ตัวเลขเงิน (แสดงผล) ---------- */

function fmtBaht(n) {
  var x = Number(n) || 0
  var neg = x < 0
  x = Math.abs(x)
  var s = String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + s
}
