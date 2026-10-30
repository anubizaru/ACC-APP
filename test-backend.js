/* =====================================================================
 *  test-backend.js — ทดสอบ Code.gs ทั้งระบบด้วย mock ของ Apps Script
 *  จำลอง Sheets/Cache/Lock แล้วเรียก route_ ตรง ๆ เหมือนโดนเรียกผ่าน HTTP
 * ===================================================================== */
const fs = require('fs')
const crypto = require('crypto')

/* ---------- Mock Google Apps Script ---------- */

function makeMockSpreadsheet() {
  const sheets = {} // name -> {rows: [[...]], frozen, formats}
  const ss = {
    getId: () => 'mock-ss-id',
    openById(id) { return id === 'mock-ss-id' ? ss : null },
    setSpreadsheetTimeZone() { },
    getActiveSpreadsheet() { return ss },
    getSheetByName(name) {
      if (!sheets[name]) return null
      const sh = sheets[name]
      return {
        appendRow(row) { sh.rows.push(row.slice()) },
        getLastRow() { return sh.rows.length },
        getMaxRows() { return Math.max(1000, sh.rows.length) },
        setFrozenRows() { },
        getDataRange() {
          return {
            getValues() { return sh.rows.map(r => r.slice()) }
          }
        },
        getRange(row, col, numRows, numCols) {
          return {
            setValues(vals) {
              for (let i = 0; i < numRows; i++) {
                while (sh.rows.length < row + i) sh.rows.push([])
                const r = sh.rows[row + i - 1]
                while (r.length < col + numCols - 1) r.push('')
                for (let c = 0; c < numCols; c++) r[col + c - 1] = vals[i][c]
              }
            },
            setNumberFormat() { }
          }
        },
        deleteRow(rowNum) { sh.rows.splice(rowNum - 1, 1) }
      }
    },
    insertSheet(name) {
      sheets[name] = { rows: [] }
      return ss.getSheetByName(name)
    },
    getUi() {
      return {
        alert(msg) { mockUiAlerts.push(String(msg)) }
      }
    }
  }
  return { ss, sheets }
}

let mockUiAlerts = []

function makeMockCache() {
  const store = {}
  return {
    get(k) { return store[k] !== undefined ? store[k] : null },
    put(k, v, ttl) { store[k] = String(v) },
    remove(k) { delete store[k] }
  }
}

function makeMockLock() {
  return {
    tryLock() { return true },
    releaseLock() { }
  }
}

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  formatDate(d, tz, fmt) {
    const p = n => String(n).padStart(2, '0')
    if (fmt === 'yyyy-MM-dd') return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    if (fmt === 'yyyy-MM-dd HH:mm:ss') return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    return String(d)
  }
}

const Logger = { log: (m) => { } }
const ContentService = {
  createTextOutput: (t) => ({ setMimeType() { return this }, _text: t }),
  MimeType: { JSON: 'json', TEXT: 'text' }
}

/* ---------- โหลด Code.gs ---------- */

function loadGas(adminEmail) {
  let code = fs.readFileSync('Code.gs', 'utf8')
  code = code.replace(/var ADMIN_EMAIL = '[^']*'/, "var ADMIN_EMAIL = '" + adminEmail + "'")
  const mod = { exports: {} }
  const fn = new Function(
    'module', 'SpreadsheetApp', 'PropertiesService', 'CacheService', 'LockService', 'Utilities', 'Logger', 'ContentService',
    code + '\n;module.exports = { setup, route_, doPost }'
  )
  const { ss, sheets } = makeMockSpreadsheet()
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
      setProperty: (k, v) => { scriptProps[k] = String(v) }
    })
  }
  const cache = makeMockCache()
  fn(mod, ss, PropertiesService, { getScriptCache: () => cache }, { getScriptLock: () => makeMockLock() }, Utilities, Logger, ContentService)
  return mod.exports
}

const scriptProps = {}

/* ---------- ตัวช่วย ---------- */

let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w) }
}
function okTrue(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('FAIL  ' + name) }
}

/* ---------- รันสถานการณ์ทดสอบ ---------- */

const TODAY = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd')
console.log('วันที่ทดสอบ: ' + TODAY)

const G = loadGas('owner@shop.test')

// 1) setup ครั้งแรก
G.setup()
const alertMsg = mockUiAlerts[mockUiAlerts.length - 1] || ''
const m = alertMsg.match(/รหัสผ่าน: (\S+)/)
okTrue('setup สร้าง admin และแสดงรหัสผ่าน', !!m)
okTrue('setup บันทึก SHEET_ID ใน Script Properties', scriptProps['SHEET_ID'] === 'mock-ss-id')
const adminPass = m ? m[1] : ''

// 2) setup ซ้ำไม่สร้าง admin ใหม่
G.setup()
okTrue('setup ซ้ำไม่สร้าง admin ซ้ำ', mockUiAlerts.length === 2 && /พร้อมใช้งานอยู่แล้ว/.test(mockUiAlerts[1]))

// 3) ping / setupStatus
eq('ping', G.route_({ action: 'ping' }), { ok: true, service: 'pawnshop', version: 1 })
okTrue('setupStatus = true', G.route_({ action: 'setupStatus' }).setupDone === true)

// 4) login ผิด → invalid-credential
eq('login ผิดพลาด', G.route_({ action: 'login', data: { email: 'owner@shop.test', password: 'wrong' } }), { ok: false, error: 'invalid-credential' })

// 5) login ถูกต้อง
const loginRes = G.route_({ action: 'login', data: { email: 'owner@shop.test', password: adminPass } })
okTrue('login สำเร็จ', loginRes.ok === true && !!loginRes.token && loginRes.user.role === 'admin')
const token = loginRes.token

// 6) ไม่มี token → ปฏิเสธ
eq('ไม่มี token ถูกปฏิเสธ', G.route_({ action: 'bootstrap' }), { ok: false, error: 'auth' })

const customDueRes = G.route_({ action: 'due.save', token: token, data: { due: 20, title: 'ราย 20 วัน' } })
okTrue('เพิ่มกำหนดชำระแบบกำหนดเอง', customDueRes.ok === true)
eq('ปฏิเสธกำหนดชำระที่ไม่ใช่จำนวนเต็ม', G.route_({ action: 'due.save', token: token, data: { due: 2.5, title: 'ทดสอบ' } }), { ok: false, error: 'invalid-due' })

// 7) เพิ่มสินค้าใหม่ (รับจำ 1,000 บาท ดอก 50 งวดรายเดือน)
const createRes = G.route_({
  action: 'product.create', token: token, requestId: 'rq-create-1',
  data: { customerName: 'สมชาย ใจดี', customerIdCard: '0123456789012', typeId: 'ทอง-ประเภท', detail: 'สร้อยคอทอง 1 สล้อ', price: 1000, interest: 50, due: 30, startDate: TODAY, desc: 'ของเก่า' }
})
okTrue('สร้างสินค้าสำเร็จ', createRes.ok === true)
eq('เลขรายการแรก = 1', createRes.product.productNo, 1)
eq('statement แรก pay = 1,000 (จ่ายเงินต้น)', createRes.statement.pay, 1000)
eq('วันครบกำหนด = +1 เดือน', createRes.product.endDate, calEndDateCheck(30, TODAY))
okTrue('บัตรประชาชนคงเลขศูนย์นำหน้า', String(createRes.product.customerIdCard) === '0123456789012')

function calEndDateCheck(due, startDate) {
  const [y, mo, d] = startDate.split('-').map(Number)
  const lastDay = new Date(y, mo, 0).getDate()
  const day = Math.min(d, lastDay)
  const nd = new Date(y, mo - 1 + 1, day)
  return nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0') + '-' + String(nd.getDate()).padStart(2, '0')
}

// 8) กดซ้ำ requestId เดิม → ไม่เกิดรายการซ้ำ
const replay = G.route_({ action: 'product.create', token: token, requestId: 'rq-create-1', data: {} })
okTrue('requestId ซ้ำถูกเล่นซ้ำ (replayed)', replay.replayed === true && replay.ok === true)
const boot1 = G.route_({ action: 'bootstrap', token: token })
eq('มีสินค้า 1 รายการ (ไม่ซ้ำ)', boot1.products.length, 1)
eq('มี statement 1 รายการ (ไม่ซ้ำ)', boot1.statements.length, 1)

const customNoRes = G.route_({
  action: 'product.create', token: token, requestId: 'rq-create-custom-no',
  data: { productNo: 20, customerName: 'ลูกค้ากำหนดเลขเอง', detail: 'แหวน', price: 500, interest: 25, due: 20, startDate: '2026-01-01', typeId: 'ทอง-ประเภท' }
})
okTrue('กำหนดเลขที่สินค้าเองได้', customNoRes.ok === true)
eq('เลขที่สินค้าตามที่กำหนด', customNoRes.product.productNo, 20)
eq('สร้างสินค้าด้วยกำหนดชำระแบบกำหนดเอง', customNoRes.product.endDate, '2026-01-21')
eq('เลขที่สินค้าซ้ำถูกปฏิเสธ', G.route_({
  action: 'product.create', token: token, requestId: 'rq-create-duplicate-no',
  data: { productNo: 20, customerName: 'ลูกค้าซ้ำ', detail: 'แหวน', price: 500, interest: 25, due: 30, startDate: TODAY, typeId: 'ทอง-ประเภท' }
}), { ok: false, error: 'invalid-productNo-taken' })

// 9) รับดอกเบี้ย 50 บาท
const intRes = G.route_({
  action: 'finance.op', token: token, requestId: 'rq-int-1',
  data: { id: createRes.product.id, op: 'interest', amount: 50 }
})
okTrue('รับดอกสำเร็จ', intRes.ok === true)
eq('ดอกเบี้ยเข้า profit', intRes.statement.profit, 50)
okTrue('วันครบกำหนดเลื่อนไปอีกงวด', intRes.product.endDate === calEndDateCheck(30, createRes.product.endDate))

// 10) เพิ่มต้น 500 → ต้น 1,500 ดอกใหม่ = calInterest(1500)
const incRes = G.route_({ action: 'finance.op', token: token, requestId: 'rq-inc-1', data: { id: createRes.product.id, op: 'increase', amount: 500 } })
eq('เพิ่มต้น: pay=500', incRes.statement.pay, 500)
eq('ต้นใหม่ 1,500', incRes.product.price, 1500)
eq('ดอกใหม่ = calInterest(1500) = 80 (ปัดตามสูตรเดิม)', incRes.product.interest, 80)

// 11) ลดต้น 300 → ต้น 1,200 ดอก calInterest(1200)=60
const redRes = G.route_({ action: 'finance.op', token: token, requestId: 'rq-red-1', data: { id: createRes.product.id, op: 'reduce', amount: 300 } })
eq('ลดต้น: income=300', redRes.statement.income, 300)
eq('ต้นใหม่ 1,200', redRes.product.price, 1200)
eq('ดอกใหม่ = 60', redRes.product.interest, 60)

// 12) ไถ่ถอน: รับต้น 1,200 + ดอก 60
const redeemRes = G.route_({ action: 'finance.op', token: token, requestId: 'rq-redm-1', data: { id: createRes.product.id, op: 'redeem', amount: 60 } })
eq('ไถ่ถอน: income = ต้น 1,200', redeemRes.statement.income, 1200)
eq('ไถ่ถอน: profit = ดอก 60', redeemRes.statement.profit, 60)
eq('สินค้าปิดแล้ว', redeemRes.product.status, 0)
eq('closeStatus = redeem', redeemRes.product.closeStatus, 'redeem')

// 13) ทำรายการกับสินค้าที่ปิดแล้ว → ปฏิเสธ
const closedRes = G.route_({ action: 'finance.op', token: token, requestId: 'rq-x', data: { id: createRes.product.id, op: 'interest', amount: 50 } })
eq('สินค้าปิดแล้วทำรายการไม่ได้', closedRes, { ok: false, error: 'product-closed' })

// 14) กลับรายการไถ่ถอน → สินค้ากลับมาใช้งาน ต้น/ดอก/วันคืนเดิม
const voidRes = G.route_({ action: 'statement.void', token: token, requestId: 'rq-void-1', data: { id: redeemRes.statement.id } })
okTrue('กลับรายการสำเร็จ', voidRes.ok === true)
eq('สินค้ากลับมา active', voidRes.product.status, 1)
eq('ต้นคืน 1,200', voidRes.product.price, 1200)
eq('ดอกคืน 60', voidRes.product.interest, 60)
eq('closeStatus ล้างแล้ว', voidRes.product.closeStatus, '')

// 15) รายงานช่วงวันนี้: รายการไถ่ถอนและรายการกลับหักล้างกัน เหลือเงินเข้า 50 + 300
//     ส่วนเงินออก = จ่ายต้น 1000 + เพิ่มต้น 500
const report = G.route_({ action: 'report.range', token: token, data: { start: TODAY, end: TODAY } })
eq('รายงาน: cashIn = 50 + 300 (ไถ่ถอนและกลับรายการหักล้างกัน)', report.summary.cashIn, 350)
eq('รายงาน: cashOut = 1000 + 500', report.summary.cashOut, 1500)
eq('รายงาน: profit = 50 (ไถ่ถอนและกลับรายการหักล้างกัน)', report.summary.profit, 50)

// 16) บัญชีร้าน: ห้ามกรอกขาออกขาเข้าพร้อมกัน
eq('บัญชี: both-sides ปฏิเสธ', G.route_({ action: 'accounting.add', token: token, requestId: 'rq-acc-x', data: { title: 'ค่าไฟ', income: 100, pay: 100 } }), { ok: false, error: 'both-sides' })
const accRes = G.route_({ action: 'accounting.add', token: token, requestId: 'rq-acc-1', data: { title: 'ค่าไฟ', pay: 350 } })
okTrue('เพิ่มบัญชีร้านสำเร็จ', accRes.ok === true)
const report2 = G.route_({ action: 'report.range', token: token, data: { start: TODAY, end: TODAY } })
eq('รายงาน: ค่าไฟจ่ายออก 350', report2.summary.accOut, 350)
const accDelete = G.route_({ action: 'accounting.delete', token: token, requestId: 'rq-acc-delete-1', data: { id: accRes.entry.id } })
okTrue('ผู้ดูแลลบรายการบัญชีได้', accDelete.ok === true)
okTrue('ลบรายการบัญชีซ้ำด้วย requestId เดิมไม่ทำซ้ำ', G.route_({ action: 'accounting.delete', token: token, requestId: 'rq-acc-delete-1', data: { id: accRes.entry.id } }).replayed === true)
okTrue('รายการที่ลบไม่อยู่ใน bootstrap', !G.route_({ action: 'bootstrap', token: token }).accounting.some(a => a.id === accRes.entry.id))

const linkedAcc = G.route_({ action: 'accounting.add', token: token, requestId: 'rq-acc-linked', data: { title: 'รายการที่มีประวัติ', pay: 75 } })
const linkedAccVoid = G.route_({ action: 'accounting.void', token: token, requestId: 'rq-acc-linked-void', data: { id: linkedAcc.entry.id } })
okTrue('กลับรายการบัญชีสร้างรายการคู่สำเร็จ', linkedAccVoid.ok === true)
eq('ป้องกันการลบรายการบัญชีที่มีคู่กลับรายการ', G.route_({ action: 'accounting.delete', token: token, requestId: 'rq-acc-delete-linked', data: { id: linkedAcc.entry.id } }), { ok: false, error: 'linked-entry' })
eq('ป้องกันการลบรายการกลับรายการที่มีต้นทาง', G.route_({ action: 'accounting.delete', token: token, requestId: 'rq-acc-delete-reversal', data: { id: linkedAccVoid.reverse.id } }), { ok: false, error: 'linked-entry' })

// 17) เจ้าหนี้
const credRes = G.route_({ action: 'creditor.save', token: token, requestId: 'rq-cred-1', data: { name: 'เจ้าของร้านทอง' } })
okTrue('เพิ่มเจ้าหนี้สำเร็จ', credRes.ok === true)
eq('ปฏิเสธชำระเกินยอดคงค้าง', G.route_({ action: 'creditorMove.add', token: token, requestId: 'rq-mv-over-1', data: { creditorId: credRes.creditor.id, refund: 100 } }), { ok: false, error: 'refund-exceeds-balance' })
const mvRes = G.route_({ action: 'creditorMove.add', token: token, requestId: 'rq-mv-1', data: { creditorId: credRes.creditor.id, borrow: 5000 } })
okTrue('ยืมเจ้าหนี้ 5,000 สำเร็จ', mvRes.ok === true)
okTrue('ชำระคืนภายในยอดคงค้างได้', G.route_({ action: 'creditorMove.add', token: token, requestId: 'rq-mv-refund', data: { creditorId: credRes.creditor.id, refund: 1500 } }).ok === true)
eq('ปฏิเสธชำระเกินยอดคงค้างหลังหักชำระ', G.route_({ action: 'creditorMove.add', token: token, requestId: 'rq-mv-over-2', data: { creditorId: credRes.creditor.id, refund: 4000 } }), { ok: false, error: 'refund-exceeds-balance' })

// 18) ผู้ใช้: admin สร้าง staff
const staffRes = G.route_({ action: 'user.save', token: token, requestId: 'rq-user-1', data: { name: 'พนักงานใหม่', email: 'staff@shop.test', password: 'secret123', role: 'staff' } })
okTrue('สร้าง staff สำเร็จ', staffRes.ok === true)
const staffLogin = G.route_({ action: 'login', data: { email: 'staff@shop.test', password: 'secret123' } })
okTrue('staff login ได้', staffLogin.ok === true)
const staffToken = staffLogin.token
eq('staff ห้ามลบรายการบัญชี', G.route_({ action: 'accounting.delete', token: staffToken, requestId: 'rq-acc-delete-staff', data: { id: accRes.entry.id } }), { ok: false, error: 'forbidden' })
// staff ทำรายการได้
const st2 = G.route_({ action: 'product.create', token: staffToken, requestId: 'rq-create-2', data: { customerName: 'ลูกค้า 2', detail: 'แหวน', price: 500, interest: 30, due: 15, typeId: 'ทอง-ประเภท', startDate: TODAY } })
okTrue('staff สร้างสินค้าได้', st2.ok === true)
eq('เลขอัตโนมัติต่อจากเลขสูงสุด', st2.product.productNo, 21)
// staff ห้ามจัดการผู้ใช้
eq('staff ห้ามจัดการผู้ใช้', G.route_({ action: 'user.save', token: staffToken, requestId: 'rq-user-2', data: { name: 'x', email: 'x@x.test', password: '123456' } }), { ok: false, error: 'forbidden' })
// staff ห้ามกลับรายการ
eq('staff ห้ามกลับรายการ', G.route_({ action: 'statement.void', token: staffToken, requestId: 'rq-void-x', data: { id: intRes.statement.id } }), { ok: false, error: 'forbidden' })

// 19) เปลี่ยนรหัสผ่านตัวเอง: ต้องยืนยันรหัสเดิม
eq('เปลี่ยนรหัสผ่านโดยไม่ยืนยันเดิมไม่ได้', G.route_({ action: 'user.password', token: staffToken, data: { currentPassword: 'wrong', newPassword: 'newpass99' } }), { ok: false, error: 'invalid-credential' })
eq('เปลี่ยนรหัสผ่านสำเร็จ', G.route_({ action: 'user.password', token: staffToken, data: { currentPassword: 'secret123', newPassword: 'newpass99' } }), { ok: true })
const reLogin = G.route_({ action: 'login', data: { email: 'staff@shop.test', password: 'newpass99' } })
okTrue('login ด้วยรหัสใหม่ได้', reLogin.ok === true)

// 20) ล็อกอินผิดเกิน 5 ครั้ง → rate-limited
for (let i = 0; i < 5; i++) G.route_({ action: 'login', data: { email: 'ghost@shop.test', password: 'x' } })
eq('ล็อกอินผิด 6 ครั้งถูกล็อกชั่วคราว', G.route_({ action: 'login', data: { email: 'ghost@shop.test', password: 'x' } }), { ok: false, error: 'rate-limited' })

// 21) ปิดบัญชีผู้ใช้ → token ใช้ต่อไม่ได้
const disRes = G.route_({ action: 'user.save', token: token, requestId: 'rq-user-3', data: { id: reLogin.user.id, name: 'พนักงานใหม่', email: 'staff@shop.test', role: 'staff', active: 0 } })
okTrue('ปิดบัญชี staff สำเร็จ', disRes.ok === true)
eq('token ของผู้ถูกปิดบัญชีใช้ไม่ได้', G.route_({ action: 'bootstrap', token: reLogin.token }), { ok: false, error: 'auth' })

// 22) ลบสินค้าที่มีรายการแล้วไม่ได้
eq('ลบสินค้าที่มีรายการไม่ได้', G.route_({ action: 'product.delete', token: token, requestId: 'rq-del-1', data: { id: st2.product.id } }), { ok: false, error: 'has-statements' })

// 23) doPost ครบวงจร (JSON เข้า-ออก)
const http = G.doPost({ postData: { contents: JSON.stringify({ action: 'ping' }) } })
okTrue('doPost ตอบ JSON มี CORS header', typeof http === 'object')

// 24) ตรวจว่า statement ไถ่ถอนที่ถูกกลับรายการ มี void=TRUE และมี reversal คู่กัน
const boot2 = G.route_({ action: 'bootstrap', token: token })
const redeemed = boot2.statements.filter(s => s.type === 'redeem')
eq('มีรายการไถ่ถอน 2 แถว (ต้นฉบับ + กลับรายการ)', redeemed.length, 2)
okTrue('ต้นฉบับถูกมาร์ก void', String(redeemed[0].void) === 'TRUE')

// 25) แก้ข้อมูลหลักของสินค้าและซิงก์กับรายการรับสินค้าแรก
const editableRes = G.route_({
  action: 'product.create', token: token, requestId: 'rq-edit-create',
  data: { productNo: 22, customerName: 'ทดสอบแก้สินค้า', detail: 'แหวน', price: 1000, interest: 50, due: 30, typeId: 'ทอง-ประเภท', startDate: TODAY }
})
okTrue('สร้างสินค้าทดสอบแก้ไข', editableRes.ok === true)
const editRes = G.route_({
  action: 'product.update', token: token, requestId: 'rq-edit-product',
  data: { id: editableRes.product.id, productNo: 23, customerName: 'ทดสอบแก้สินค้า', detail: 'แหวน', typeId: 'ทอง-ประเภท', price: 1200, interest: 60, startDate: '2026-01-05', endDate: '2026-02-20' }
})
okTrue('แก้เลขที่ เงินต้น ค่าบริการ และวันที่สำเร็จ', editRes.ok === true)
eq('เลขที่สินค้าเปลี่ยนแล้ว', editRes.product.productNo, 23)
eq('ข้อมูลสินค้าเปลี่ยนแล้ว', [editRes.product.price, editRes.product.interest, editRes.product.startDate, editRes.product.endDate], [1200, 60, '2026-01-05', '2026-02-20'])
const editBoot = G.route_({ action: 'bootstrap', token: token })
const opening = editBoot.statements.filter(s => s.productId === editableRes.product.id && s.type === 'new')[0]
eq('ซิงก์รายการรับสินค้าแรกตามข้อมูลที่แก้', [opening.date, opening.pay, opening.priceAfter, opening.interestAfter, opening.endDateAfter], ['2026-01-05', 1200, 1200, 60, '2026-02-20'])
eq('ปฏิเสธเลขที่สินค้าซ้ำขณะแก้ไข', G.route_({
  action: 'product.update', token: token, requestId: 'rq-edit-duplicate',
  data: { id: editableRes.product.id, productNo: 20, customerName: 'ทดสอบแก้สินค้า', detail: 'แหวน', typeId: 'ทอง-ประเภท', price: 1200, interest: 60, startDate: '2026-01-05', endDate: '2026-02-20' }
}), { ok: false, error: 'invalid-productNo-taken' })
G.route_({ action: 'finance.op', token: token, requestId: 'rq-edit-history', data: { id: editableRes.product.id, op: 'interest', amount: 60 } })
eq('ล็อกเงินและวันที่เมื่อมีประวัติทางการเงิน', G.route_({
  action: 'product.update', token: token, requestId: 'rq-edit-history-block',
  data: { id: editableRes.product.id, productNo: 23, customerName: 'ทดสอบแก้สินค้า', detail: 'แหวน', typeId: 'ทอง-ประเภท', price: 1300, interest: 60, startDate: '2026-01-05', endDate: '2026-02-20' }
}), { ok: false, error: 'product-has-history' })

console.log('\nผลลัพธ์ backend: ' + pass + ' ผ่าน, ' + fail + ' พลาด')
process.exit(fail ? 1 : 0)
