/* =====================================================================
 *  connect-mock-server.js — จำลอง backend Apps Script สำหรับทดสอบ "ตอนเชื่อมต่อ"
 *  รัน Code.gs ตัวจริงผ่าน doPost() พร้อม mock ของ Apps Script services
 *  ใช้คู่กับ Playwright ที่ route คำขอ script.google.com มาที่เซิร์ฟเวอร์นี้
 *
 *  รัน: node scripts/connect-mock-server.js  (ฟังพอร์ต 8123)
 *  - POST /ok        → อินสแตนซ์ที่รัน setup แล้ว (setupDone = true)
 *  - POST /nosetup   → อินสแตนซ์ที่ยังไม่ได้รัน setup (setupDone = false)
 *  รหัสผ่าน admin ของอินสแตนซ์ /ok เขียนไว้ที่ /tmp/mock-admin.json
 * ===================================================================== */
const fs = require('fs')
const crypto = require('crypto')
const http = require('http')

function makeMockSpreadsheet() {
  const sheets = {} // name -> {rows: [[...]]}
  const uiAlerts = []
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
          return { getValues() { return sh.rows.map(r => r.slice()) } }
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
      return { alert(msg) { uiAlerts.push(String(msg)) } }
    }
  }
  return { ss, uiAlerts }
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
const Logger = { log: () => { } }
const ContentService = {
  createTextOutput: (t) => ({ setMimeType() { return this }, _text: t }),
  MimeType: { JSON: 'json', TEXT: 'text' }
}

/* โหลด Code.gs เป็นอินสแตนซ์ + คืน uiAlerts ให้อ่านข้อความจาก setup ได้ */
function loadInstance(adminEmail) {
  let code = fs.readFileSync('Code.gs', 'utf8')
  code = code.replace("var ADMIN_EMAIL = 'admin@example.com'", "var ADMIN_EMAIL = '" + adminEmail + "'")
  const mod = { exports: {} }
  const fn = new Function(
    'module', 'SpreadsheetApp', 'PropertiesService', 'CacheService', 'LockService', 'Utilities', 'Logger', 'ContentService',
    code + '\n;module.exports = { setup, route_, doPost }'
  )
  const { ss, uiAlerts } = makeMockSpreadsheet()
  const scriptProps = {}
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
      setProperty: (k, v) => { scriptProps[k] = String(v) }
    })
  }
  const cache = makeMockCache()
  fn(mod, ss, PropertiesService, { getScriptCache: () => cache }, { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { } }) }, Utilities, Logger, ContentService)
  return { exp: mod.exports, uiAlerts }
}

function makeMockCache() {
  const store = {}
  return {
    get(k) { return store[k] !== undefined ? store[k] : null },
    put(k, v, ttl) { store[k] = String(v) },
    remove(k) { delete store[k] }
  }
}

/* อินสแตนซ์ที่พร้อมใช้: รัน setup แล้ว เก็บรหัสผ่าน admin */
const OK = loadInstance('owner@shop.test')
OK.exp.setup()
const m = (OK.uiAlerts[0] || '').match(/รหัสผ่าน: (\S+)/)
fs.writeFileSync('/tmp/mock-admin.json', JSON.stringify({ email: 'owner@shop.test', password: m ? m[1] : '' }))
console.log('setup done, admin password saved to /tmp/mock-admin.json')

/* อินสแตนซ์ที่ยังไม่ได้รัน setup */
const NOSETUP = loadInstance('owner@shop.test')

const server = http.createServer((req, res) => {
  const id = req.url.replace(/^\//, '').split('?')[0]
  if (req.method !== 'POST' || (id !== 'ok' && id !== 'nosetup')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not-found')
    return
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const inst = id === 'ok' ? OK.exp : NOSETUP.exp
      const out = inst.doPost({ postData: { contents: body } })
      const json = out && out._text ? out._text : JSON.stringify({ ok: false, error: 'server-error' })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(json)
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: false, error: 'server-error' }))
    }
  })
})

const PORT = 8123
server.listen(PORT, () => {
  console.log('connect-mock-server listening on ' + PORT)
})
