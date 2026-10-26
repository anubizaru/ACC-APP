/* =====================================================================
 *  build-demo.js — สร้าง js/demo-engine.js
 *  ใช้ Code.gs ตัวจริง + mock ในเบราว์เซอร์ + ข้อมูลตัวอย่างที่สร้างจาก API จริง
 *  รัน: node build-demo.js
 * ===================================================================== */
const fs = require('fs')
const crypto = require('crypto')

let code = fs.readFileSync('Code.gs', 'utf8')
code = code.replace(/var ADMIN_EMAIL = '[^']*'/, "var ADMIN_EMAIL = 'demo@pawn.test'")

const TODAY = new Date()
const p = n => String(n).padStart(2, '0')
const fmt = d => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
const todayStr = fmt(TODAY)
const daysAgo = n => { const d = new Date(TODAY); d.setDate(d.getDate() - n); return fmt(d) }
const monthsAgo = n => { const d = new Date(TODAY); d.setMonth(d.getMonth() - n); return fmt(d) }

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  formatDate(d, tz, f) {
    if (f === 'yyyy-MM-dd') return fmt(d)
    if (f === 'yyyy-MM-dd HH:mm:ss') return fmt(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    return String(d)
  }
}
const Logger = { log: () => { } }

/* mock spreadsheet ในหน่วยความจำ */
function makeSheets() {
  const sheets = {}
  const ss = {
    setSpreadsheetTimeZone() { },
    getActiveSpreadsheet() { return ss },
    getSheetByName(name) {
      if (!sheets[name]) return null
      const sh = sheets[name]
      return {
        appendRow(row) { sh.push(row.slice()) },
        getLastRow() { return sh.length },
        getMaxRows() { return 1000 },
        setFrozenRows() { },
        getDataRange() { return { getValues: () => sh.map(r => r.slice()) } },
        getRange(row, col, numRows, numCols) {
          return {
            setValues(vals) {
              for (let i = 0; i < numRows; i++) {
                while (sh.length < row + i) sh.push([])
                const r = sh[row + i - 1]
                while (r.length < col + numCols - 1) r.push('')
                for (let c = 0; c < numCols; c++) r[col + c - 1] = vals[i][c]
              }
            },
            setNumberFormat() { }
          }
        },
        deleteRow(n) { sh.splice(n - 1, 1) }
      }
    },
    insertSheet(name) { sheets[name] = []; return ss.getSheetByName(name) },
    getUi() { return { alert: () => { } } }
  }
  return { ss, sheets }
}

const { ss, sheets } = makeSheets()
const cacheStore = {}
const cache = {
  get: k => (cacheStore[k] !== undefined ? cacheStore[k] : null),
  put: (k, v) => { cacheStore[k] = String(v) },
  remove: k => { delete cacheStore[k] }
}
const mod = { exports: {} }
new Function('module', 'SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'Logger', 'ContentService',
  code + '\n;module.exports = { setup, route_ }')(
    mod, ss, { getScriptCache: () => cache }, { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { } }) }, Utilities, Logger, {})
const G = mod.exports

/* ---------- เตรียมข้อมูลตัวอย่างผ่าน API จริง ---------- */

G.setup()

// เปลี่ยนรหัสผ่าน admin เป็น demo1234 (เขียนตรง ๆ เพราะ mock)
const emps = sheets.Employees
for (let i = 1; i < emps.length; i++) {
  const salt = String(crypto.randomBytes(16).toString('hex'))
  // ใช้ hashPassword ของ Code.gs เอง
  const hash = hashOf('demo1234', salt)
  emps[i][3] = hash
  emps[i][4] = salt
}
function hashOf(pw, saltHex) {
  // PBKDF2-HMAC-SHA256 ด้วย node crypto (ตรงกับ hashPassword ของ Code.gs ซึ่งทดสอบแล้ว)
  return crypto.pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), 10000, 32, 'sha256').toString('hex')
}

const login = G.route_({ action: 'login', data: { email: 'demo@pawn.test', password: 'demo1234' } })
if (!login.ok) { console.error('seed login fail', login); process.exit(1) }
const token = login.token
const rq = { token }

function call(action, data, requestId) {
  const res = G.route_({ action, data, token, requestId })
  if (!res.ok) { console.error('seed fail:', action, JSON.stringify(res)); process.exit(1) }
  return res
}

// ประเภทสินค้าเพิ่มเติม
call('type.save', { name: 'จิวเวลรี่' })

// ดึง typeId จริงจากชีต (setup สร้าง id แบบสุ่ม)
const typeIds = {}
for (let i = 1; i < sheets.Types.length; i++) typeIds[sheets.Types[i][1]] = sheets.Types[i][0]

// สินค้าตัวอย่าง
const p1 = call('product.create', { customerName: 'สมศักดิ์ รักทอง', customerIdCard: '0123456789012', typeId: typeIds['ทอง'], detail: 'สร้อยคอทอง 2 สล้อ', price: 5000, interest: 250, due: 30, startDate: monthsAgo(1) }, 'seed-p1').product
call('finance.op', { id: p1.id, op: 'interest', amount: 250, date: daysAgo(3) }, 'seed-p1-i')

const p2 = call('product.create', { customerName: 'มาลี ขยันสู้', customerIdCard: '0987654321098', typeId: typeIds['ทอง'], detail: 'แหวนทอง 3.2 กรัม', price: 8000, interest: 400, due: 30, startDate: monthsAgo(2) }, 'seed-p2').product
call('finance.op', { id: p2.id, op: 'interest', amount: 400, date: daysAgo(35) }, 'seed-p2-i')

const p3 = call('product.create', { customerName: 'ประเสริฐ มีสุข', detail: 'นาฬิกา Casio', price: 1500, interest: 75, due: 15, startDate: daysAgo(20), typeId: typeIds['นาฬิกา'] }, 'seed-p3').product

const p4 = call('product.create', { customerName: 'วิภา ใจบุญ', detail: 'iPhone 12 128GB', price: 12000, interest: 600, due: 30, startDate: monthsAgo(3), typeId: typeIds['มือถือ'] }, 'seed-p4').product
call('finance.op', { id: p4.id, op: 'interest', amount: 600, date: daysAgo(60) }, 'seed-p4-i')
call('finance.op', { id: p4.id, op: 'redeem', amount: 600, date: daysAgo(5) }, 'seed-p4-r')

const p5 = call('product.create', { customerName: 'ธนากร เพียรทอง', detail: 'กำไลทอง 1 บาท', price: 28000, interest: 1400, due: 30, startDate: monthsAgo(4), typeId: typeIds['ทอง'] }, 'seed-p5').product
call('finance.op', { id: p5.id, op: 'increase', amount: 2000, date: daysAgo(40) }, 'seed-p5-i')
call('finance.op', { id: p5.id, op: 'sale', amount: 31000, date: daysAgo(2) }, 'seed-p5-s')

const p6 = call('product.create', { customerName: 'สุนิสา แสงระวีง', detail: 'สร้อยข้อมือเงิน', price: 900, interest: 45, due: 10, startDate: daysAgo(8), typeId: typeIds['จิวเวลรี่'] }, 'seed-p6').product

// บัญชีร้าน
call('accounting.add', { title: 'ค่าไฟฟ้า', pay: 480, date: daysAgo(2) }, 'seed-a1')
call('accounting.add', { title: 'ขายกระดาษห่อสินค้า', income: 150, date: daysAgo(1) }, 'seed-a2')
call('accounting.add', { title: 'ค่าน้ำมือเชียร์รถ', pay: 200, date: todayStr }, 'seed-a3')

// เจ้าหนี้
const c1 = call('creditor.save', { name: 'ร้านทองเจริญพาณิชย์' }, 'seed-c1').creditor
call('creditorMove.add', { creditorId: c1.id, borrow: 50000, date: monthsAgo(1) }, 'seed-c1-m1')
call('creditorMove.add', { creditorId: c1.id, refund: 10000, date: daysAgo(10) }, 'seed-c1-m2')

/* ---------- สร้าง demo-engine.js ---------- */

const engine = `/* สร้างโดย build-demo.js — อย่าแก้ไฟล์นี้โดยตรง */
/* โหมดทดลอง: ใช้ Code.gs ตัวจริงรันในเบราว์เซอร์ + ข้อมูลตัวอย่าง */
(function () {
  var DATA = ${JSON.stringify(sheets)};
  var CACHE = {};
  var TODAY = ${JSON.stringify(todayStr)};

  function makeSS(sheets) {
    var ss = {
      setSpreadsheetTimeZone: function () { },
      getActiveSpreadsheet: function () { return ss },
      getSheetByName: function (name) {
        var sh = sheets[name];
        if (!sh) return null;
        return {
          appendRow: function (row) { sh.push(row.slice()) },
          getLastRow: function () { return sh.length },
          getMaxRows: function () { return 1000 },
          setFrozenRows: function () { },
          getDataRange: function () { return { getValues: function () { return sh.map(function (r) { return r.slice() }) } } },
          getRange: function (row, col, numRows, numCols) {
            return {
              setValues: function (vals) {
                for (var i = 0; i < numRows; i++) {
                  while (sh.length < row + i) sh.push([]);
                  var r = sh[row + i - 1];
                  while (r.length < col + numCols - 1) r.push('');
                  for (var c = 0; c < numCols; c++) r[col + c - 1] = vals[i][c];
                }
              },
              setNumberFormat: function () { }
            };
          },
          deleteRow: function (n) { sh.splice(n - 1, 1) }
        };
      },
      insertSheet: function (name) { sheets[name] = []; return ss.getSheetByName(name) },
      getUi: function () { return { alert: function () { } } }
    };
    return ss;
  }

  var m = { exports: {} };
  new Function('module', 'SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'Logger',
    ${JSON.stringify(code)} + '\\n;module.exports = { setup: setup, route_: route_ }')(
    m,
    makeSS(DATA),
    { getScriptCache: function () { return {
      get: function (k) { return CACHE[k] !== undefined ? CACHE[k] : null },
      put: function (k, v) { CACHE[k] = String(v) },
      remove: function (k) { delete CACHE[k] }
    } } },
    { getScriptLock: function () { return { tryLock: function () { return true }, releaseLock: function () { } } } },
    {
      getUuid: function () {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      },
      formatDate: function (d, tz, f) {
        var p = function (n) { return String(n).padStart(2, '0') };
        if (f === 'yyyy-MM-dd') return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        if (f === 'yyyy-MM-dd HH:mm:ss') return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        return String(d);
      }
    },
    { log: function () { } }
  );

  window.DemoEngine = m.exports;
  window.DemoToday = TODAY;
})();
`
fs.writeFileSync('js/demo-engine.js', engine)
console.log('สร้าง js/demo-engine.js แล้ว (' + (engine.length / 1024).toFixed(0) + ' KB)')
console.log('ข้อมูลตัวอย่าง: สินค้า ' + sheets.Products.length + ' แถว, statements ' + sheets.Statements.length + ' แถว')
