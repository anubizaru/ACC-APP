/* =========================================================
 *  BACKEND — Google Apps Script Web App
 *  ระบบบัญชีร้านรับจำนำ บน Google Sheets
 *  (ส่วนนี้จะถูกประกอบเป็น Code.gs ร่วมกับ logic.js + pbkdf2.js)
 * ========================================================= */

var TZ = 'Asia/Bangkok'
var TOKEN_TTL = 21600 // 6 ชั่วโมง (ค่าสูงสุดของ CacheService)

var TAB = {
  EMPLOYEES: 'Employees',
  PRODUCTS: 'Products',
  STATEMENTS: 'Statements',
  ACCOUNTING: 'Accounting',
  CREDITORS: 'Creditors',
  CREDITOR_MOVES: 'CreditorMoves',
  TYPES: 'Types',
  DUE: 'Due',
  OPERATIONS: 'Operations',
  CONFIG: 'Config'
}

var COLS = {}
COLS[TAB.EMPLOYEES] = ['id', 'name', 'email', 'passwordHash', 'salt', 'role', 'avatar', 'active', 'createdAt']
COLS[TAB.PRODUCTS] = ['id', 'productNo', 'customerName', 'customerIdCard', 'typeId', 'detail', 'price', 'interest', 'due', 'startDate', 'endDate', 'status', 'closeStatus', 'desc', 'createdBy', 'createdAt', 'updatedAt']
COLS[TAB.STATEMENTS] = ['id', 'productId', 'type', 'date', 'income', 'pay', 'profit', 'priceAfter', 'interestAfter', 'dueAfter', 'endDateAfter', 'closeStatusAfter', 'note', 'requestId', 'createdBy', 'createdAt', 'void', 'voidOf']
COLS[TAB.ACCOUNTING] = ['id', 'date', 'title', 'income', 'pay', 'note', 'requestId', 'createdBy', 'createdAt', 'void', 'voidOf']
COLS[TAB.CREDITORS] = ['id', 'name', 'note', 'createdBy', 'createdAt']
COLS[TAB.CREDITOR_MOVES] = ['id', 'creditorId', 'date', 'borrow', 'refund', 'note', 'requestId', 'createdBy', 'createdAt']
COLS[TAB.TYPES] = ['id', 'name', 'icon']
COLS[TAB.DUE] = ['id', 'due', 'unit', 'title', 'color']
COLS[TAB.OPERATIONS] = ['requestId', 'userId', 'action', 'status', 'entityId', 'createdAt', 'committedAt', 'resultJson']
COLS[TAB.CONFIG] = ['key', 'value']

// คอลัมน์วันที่ (เก็บเป็น string YYYY-MM-DD)
var DATE_COLS = {
  Products: ['startDate', 'endDate'],
  Statements: ['date'],
  Accounting: ['date'],
  CreditorMoves: ['date'],
  Creditors: [],
  Employees: []
}

/* ---------- ตั้งค่าเริ่มต้น: รันจาก editor ครั้งแรก ---------- */

// เปิดสเปรดชีต: ใช้ ID ที่ setup บันทึกไว้ใน Script Properties ก่อน (ชัวร์ว่าใช้ได้ในบริบท Web App)
// ถ้าไม่มี ID หรือเปิดไม่ได้ ให้ย้อนกลับไปใช้ getActiveSpreadsheet() ตามเดิม
function ss_() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID')
    if (id) {
      var byId = SpreadsheetApp.openById(id)
      if (byId) return byId
    }
  } catch (err) { }
  return SpreadsheetApp.getActiveSpreadsheet()
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  if (!ss) {
    throw new Error('โปรเจกต์นี้ไม่ได้ผูกกับ Google Sheet — ให้เปิด Google Sheet ของคุณ แล้วไปเมนู ส่วนขยาย (Extensions) > Apps Script แล้ววางโค้ดนี้ในโปรเจกต์ที่เปิดขึ้นมา (ห้ามสร้างจากหน้า script.google.com)')
  }
  try {
    PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId())
  } catch (err) { }
  ensureTabs_(ss)

  // ปรับ timezone ของ spreadsheet
  try { ss.setSpreadsheetTimeZone(TZ) } catch (err) { }

  // คอลัมน์บัตรประชาชน: บังคับเป็น text เพื่อรักษาเลขศูนย์นำหน้า
  var prod = ss.getSheetByName(TAB.PRODUCTS)
  var cardCol = COLS[TAB.PRODUCTS].indexOf('customerIdCard') + 1
  prod.getRange(1, cardCol, prod.getMaxRows(), 1).setNumberFormat('@')

  // seed กำหนดชำระ
  var due = ss.getSheetByName(TAB.DUE)
  if (due.getLastRow() < 2) {
    due.appendRow(['due-30', 30, 'month', 'รายเดือน', 'green'])
    due.appendRow(['due-15', 15, 'day', '15 วัน', 'amber'])
    due.appendRow(['due-10', 10, 'day', '10 วัน', 'pink'])
    due.appendRow(['due-0', 0, 'none', 'ขายสินค้า', 'grey'])
  }

  // seed ประเภทสินค้า
  var types = ss.getSheetByName(TAB.TYPES)
  if (types.getLastRow() < 2) {
    types.appendRow([uuid_(), 'ทอง', ''])
    types.appendRow([uuid_(), 'นาฬิกา', ''])
    types.appendRow([uuid_(), 'มือถือ', ''])
    types.appendRow([uuid_(), 'สิ่งของอื่น ๆ', ''])
  }

  // สร้าง admin คนแรก
  var emps = ss.getSheetByName(TAB.EMPLOYEES)
  if (emps.getLastRow() < 2) {
    var email = ADMIN_EMAIL
    if (!email || email.indexOf('@') < 0) {
      throw new Error('กรุณาแก้ค่า ADMIN_EMAIL ที่ด้านบนของไฟล์ก่อนรัน setup')
    }
    var password = randomPass_()
    var salt = randomSalt_()
    var hash = hashPassword(password, salt, PBKDF2_ITER)
    emps.appendRow([uuid_(), 'ผู้จัดการ', email, hash, salt, 'admin', '', 1, nowStr_()])
    setConfig_('setupDone', '1')
    var msg = 'ตั้งค่าเสร็จเรียบร้อย\n\nบัญชีผู้ดูแลระบบ:\nอีเมล: ' + email + '\nรหัสผ่าน: ' + password + '\n\nกรุณาจดรหัสผ่านไว้ แล้วเข้าสู่ระบบเพื่อเปลี่ยนรหัสผ่านใหม่'
    try {
      SpreadsheetApp.getUi().alert(msg)
    } catch (err) {
      Logger.log(msg)
    }
  } else {
    try {
      SpreadsheetApp.getUi().alert('ระบบพร้อมใช้งานอยู่แล้ว (มีผู้ใช้ในฐานข้อมูล)')
    } catch (err) { }
  }
}

// ★★★ แก้เป็นอีเมลของคุณก่อนรัน setup ★★★
var ADMIN_EMAIL = 'admin@example.com'
var PBKDF2_ITER = 10000

function ensureTabs_(ss) {
  Object.keys(COLS).forEach(function (name) {
    var sh = ss.getSheetByName(name)
    if (!sh) {
      sh = ss.insertSheet(name)
      sh.appendRow(COLS[name])
      sh.setFrozenRows(1)
    } else if (sh.getLastRow() === 0) {
      sh.appendRow(COLS[name])
      sh.setFrozenRows(1)
    }
  })
}

/* ---------- เวลา ---------- */

function nowStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')
}
function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')
}
function uuid_() {
  return Utilities.getUuid()
}
function randomSalt_() {
  // UUID สุ่มจากระบบ ใช้เป็น salt ได้ (32 อักขระ hex)
  return String(Utilities.getUuid()).replace(/-/g, '')
}
function randomPass_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  var s = ''
  for (var i = 0; i < 10; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

/* ---------- ตัวช่วย Sheets ---------- */

function readAll_(tabName) {
  var sh = ss_().getSheetByName(tabName)
  if (!sh || sh.getLastRow() < 2) return []
  var values = sh.getDataRange().getValues()
  var cols = COLS[tabName]
  var out = []
  for (var r = 1; r < values.length; r++) {
    var row = values[r]
    if (!row[0]) continue
    var obj = { _row: r + 1 }
    for (var c = 0; c < cols.length; c++) {
      var v = row[c]
      // ปกติวันที่: ถ้า Sheets แปลงเป็น Date ให้กลับเป็น string YYYY-MM-DD
      if (v instanceof Date) {
        v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
        if (DATE_COLS[tabName] && DATE_COLS[tabName].indexOf(cols[c]) < 0) {
          v = Utilities.formatDate(row[c], TZ, 'yyyy-MM-dd HH:mm:ss')
        }
      }
      obj[cols[c]] = v
    }
    out.push(obj)
  }
  return out
}

function appendObj_(tabName, obj) {
  var sh = ss_().getSheetByName(tabName)
  var cols = COLS[tabName]
  var row = cols.map(function (c) {
    var v = obj[c]
    if (v === undefined || v === null) v = ''
    if (typeof v === 'string' && v !== '') v = sanitizeCell(v)
    return v
  })
  sh.appendRow(row)
  return sh.getLastRow()
}

function updateObj_(tabName, obj) {
  // obj ต้องมี _row
  var sh = ss_().getSheetByName(tabName)
  var cols = COLS[tabName]
  var row = cols.map(function (c) {
    var v = obj[c]
    if (v === undefined || v === null) v = ''
    if (typeof v === 'string' && v !== '') v = sanitizeCell(v)
    return v
  })
  sh.getRange(obj._row, 1, 1, cols.length).setValues([row])
}

function setConfig_(key, value) {
  var sh = ss_().getSheetByName(TAB.CONFIG)
  var rows = readAll_(TAB.CONFIG)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      rows[i].value = String(value)
      updateObj_(TAB.CONFIG, rows[i])
      return
    }
  }
  sh.appendRow([key, String(value)])
}
function getConfig_(key) {
  var rows = readAll_(TAB.CONFIG)
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i].value
  return null
}

/* ---------- Web App entry ---------- */

function doPost(e) {
  var out
  try {
    var body = {}
    try { body = JSON.parse(e.postData.contents) } catch (err) { }
    out = route_(body)
  } catch (err) {
    out = { ok: false, error: 'server-error' }
    try { Logger.log('doPost: ' + err) } catch (e2) { }
  }
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON)
}

/* ---------- กระจาย action ---------- */

function route_(req) {
  var action = req.action
  var data = req.data || {}

  // สาธารณะ
  if (action === 'ping') return { ok: true, service: 'pawnshop', version: 1 }
  if (action === 'setupStatus') {
    return { ok: true, setupDone: getConfig_('setupDone') === '1' }
  }
  if (action === 'login') return login_(data)

  // ต้องล็อกอิน
  var user = auth_(req.token)
  if (!user) return { ok: false, error: 'auth' }

  if (action === 'logout') return logout_(req.token)
  if (action === 'me') return { ok: true, user: publicUser_(user) }
  if (action === 'bootstrap') return bootstrap_(user)
  if (action === 'product.create') return productCreate_(data, user, req.requestId)
  if (action === 'product.update') return productUpdate_(data, user, req.requestId)
  if (action === 'product.get') return productGet_(data, user)
  if (action === 'product.delete') return productDelete_(data, user, req.requestId)
  if (action === 'finance.op') return financeOp_(data, user, req.requestId)
  if (action === 'statement.void') return statementVoid_(data, user, req.requestId)
  if (action === 'accounting.add') return accountingAdd_(data, user, req.requestId)
  if (action === 'accounting.void') return accountingVoid_(data, user, req.requestId)
  if (action === 'creditor.save') return creditorSave_(data, user, req.requestId)
  if (action === 'creditorMove.add') return creditorMoveAdd_(data, user, req.requestId)
  if (action === 'report.range') return reportRange_(data, user)
  if (action === 'type.save') return typeSave_(data, user)
  if (action === 'due.save') return dueSave_(data, user)
  if (action === 'user.save') return userSave_(data, user, req.requestId)
  if (action === 'user.password') return userPassword_(data, user)

  return { ok: false, error: 'unknown-action' }
}

/* ---------- การยืนยันตัวตน ---------- */

function auth_(token) {
  if (!token) return null
  var userId = CacheService.getScriptCache().get('tk_' + token)
  if (!userId) return null
  var rows = readAll_(TAB.EMPLOYEES)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === userId) {
      if (String(rows[i].active) !== 'true' && Number(rows[i].active) !== 1) return null
      CacheService.getScriptCache().put('tk_' + token, userId, TOKEN_TTL) // ต่ออายุ
      return rows[i]
    }
  }
  return null
}

function publicUser_(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, avatar: u.avatar }
}

function login_(data) {
  var email = String(data.email || '').trim().toLowerCase()
  var password = String(data.password || '')
  if (!email || !password) return { ok: false, error: 'invalid-input' }

  // จำกัดการลองผิด: 5 ครั้ง แล้วล็อก 15 นาที
  var cache = CacheService.getScriptCache()
  var failKey = 'fail_' + email
  var fails = Number(cache.get(failKey) || 0)
  if (fails >= 5) return { ok: false, error: 'rate-limited' }

  var rows = readAll_(TAB.EMPLOYEES)
  var user = null
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email || '').toLowerCase() === email) { user = rows[i]; break }
  }
  if (!user || String(user.active) === 'false' || Number(user.active) === 0) {
    cache.put(failKey, String(fails + 1), 900)
    return { ok: false, error: 'invalid-credential' }
  }
  var hash = hashPassword(password, String(user.salt), PBKDF2_ITER)
  if (hash !== String(user.passwordHash)) {
    cache.put(failKey, String(fails + 1), 900)
    return { ok: false, error: 'invalid-credential' }
  }
  cache.remove(failKey)

  var token = uuid_()
  cache.put('tk_' + token, user.id, TOKEN_TTL)
  return { ok: true, token: token, user: publicUser_(user) }
}

function logout_(token) {
  CacheService.getScriptCache().remove('tk_' + token)
  return { ok: true }
}

function requireAdmin_(user) {
  return user.role === 'admin'
}

/* ---------- Idempotency (กันบันทึกซ้ำ) ---------- */

function findOp_(requestId) {
  var rows = readAll_(TAB.OPERATIONS)
  for (var i = 0; i < rows.length; i++) if (rows[i].requestId === requestId) return rows[i]
  return null
}

function withIdempotency_(requestId, user, action, fn) {
  // คืน {replayed:true,result} ถ้าเคยทำแล้ว, หรือรัน fn ภายใต้ lock
  if (!requestId) requestId = uuid_()
  var lock = LockService.getScriptLock()
  var waited = lock.tryLock(30000)
  if (!waited) return { ok: false, error: 'busy' }
  try {
    var existing = findOp_(requestId)
    if (existing) {
      if (existing.status === 'committed') {
        var res = {}
        try { res = JSON.parse(existing.resultJson) } catch (err) { }
        res.replayed = true
        return res
      }
      if (existing.status === 'pending') {
        // เคยเริ่มแต่ไม่จบ: fn ต้องออกแบบให้ run ซ้ำได้ (recovery) — เรียกซ้ำเลย
        return fn(requestId, existing)
      }
    }
    // บันทึก pending ก่อนเริ่ม
    appendObj_(TAB.OPERATIONS, {
      requestId: requestId, userId: user.id, action: action, status: 'pending',
      entityId: '', createdAt: nowStr_(), committedAt: '', resultJson: ''
    })
    return fn(requestId, null)
  } finally {
    lock.releaseLock()
  }
}

function commitOp_(requestId, entityId, result) {
  var rows = readAll_(TAB.OPERATIONS)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].requestId === requestId) {
      rows[i].status = 'committed'
      rows[i].entityId = entityId || ''
      rows[i].committedAt = nowStr_()
      rows[i].resultJson = JSON.stringify(result)
      updateObj_(TAB.OPERATIONS, rows[i])
      return
    }
  }
}

/* ---------- bootstrap (ข้อมูลทั้งหมดสำหรับเปิดแอป) ---------- */

function bootstrap_(user) {
  var products = readAll_(TAB.PRODUCTS)
  var statements = readAll_(TAB.STATEMENTS)
  var accounting = readAll_(TAB.ACCOUNTING)
  var creditors = readAll_(TAB.CREDITORS)
  var moves = readAll_(TAB.CREDITOR_MOVES)
  var types = readAll_(TAB.TYPES)
  var due = readAll_(TAB.DUE)
  var employees = readAll_(TAB.EMPLOYEES)

  var clean = function (arr) {
    return arr.map(function (r) {
      var o = {}
      for (var k in r) if (k !== '_row') o[k] = r[k]
      return o
    })
  }

  return {
    ok: true,
    today: todayStr_(),
    products: clean(products),
    statements: clean(statements),
    accounting: clean(accounting),
    creditors: clean(creditors),
    creditorMoves: clean(moves),
    types: clean(types),
    due: clean(due),
    employees: user.role === 'admin' ? clean(employees).map(function (u) {
      return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.createdAt }
    }) : []
  }
}

/* ---------- สินค้า ---------- */

function nextProductNo_() {
  var rows = readAll_(TAB.PRODUCTS)
  var max = 0
  for (var i = 0; i < rows.length; i++) {
    var n = Number(rows[i].productNo)
    if (n > max) max = n
  }
  return max + 1
}

function validateProduct_(data, isCreate) {
  var out = {}
  out.customerName = String(data.customerName || '').trim()
  if (!out.customerName) return { error: 'customerName' }
  out.customerIdCard = String(data.customerIdCard || '').trim()
  out.typeId = String(data.typeId || '')
  if (!out.typeId) return { error: 'typeId' }
  out.detail = String(data.detail || '').trim()
  if (!out.detail) return { error: 'detail' }
  out.price = toIntBaht(data.price)
  if (out.price === null || out.price <= 0) return { error: 'price' }
  if (isCreate) {
    out.interest = toIntBaht(data.interest)
    if (out.interest === null || out.interest < 0) return { error: 'interest' }
    out.due = Number(data.due)
    if ([0, 10, 15, 30].indexOf(out.due) < 0) return { error: 'due' }
    out.startDate = String(data.startDate || todayStr_()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.startDate)) return { error: 'startDate' }
    out.endDate = calEndDate(out.due, out.startDate)
    out.desc = String(data.desc || '').trim()
  }
  return { value: out }
}

function productCreate_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'product.create', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var v = validateProduct_(data, true)
    if (v.error) return { ok: false, error: 'invalid-' + v.error }

    var productNo = nextProductNo_()
    var id = uuid_()
    var product = {
      id: id, productNo: productNo, customerName: v.value.customerName,
      customerIdCard: v.value.customerIdCard, typeId: v.value.typeId, detail: v.value.detail,
      price: v.value.price, interest: v.value.interest, due: v.value.due,
      startDate: v.value.startDate, endDate: v.value.endDate, status: 1, closeStatus: '',
      desc: v.value.desc, createdBy: user.id, createdAt: nowStr_(), updatedAt: nowStr_()
    }
    appendObj_(TAB.PRODUCTS, product)

    // statement แรก: ร้านจ่ายเงินต้นออก (pay = price) ตามธรรมชาติของระบบเดิม
    var st = {
      id: uuid_(), productId: id, type: 'new', date: v.value.startDate,
      income: 0, pay: v.value.price, profit: 0,
      priceAfter: v.value.price, interestAfter: v.value.interest, dueAfter: v.value.due,
      endDateAfter: v.value.endDate, closeStatusAfter: '',
      note: 'รับสินค้าใหม่', requestId: rid, createdBy: user.id, createdAt: nowStr_(), void: '', voidOf: ''
    }
    appendObj_(TAB.STATEMENTS, st)

    var result = { ok: true, product: product, statement: st }
    commitOp_(rid, id, result)
    return result
  })
}

function productUpdate_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'product.update', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var rows = readAll_(TAB.PRODUCTS)
    var p = null
    for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { p = rows[i]; break }
    if (!p) return { ok: false, error: 'not-found' }
    if (Number(p.status) === 0) return { ok: false, error: 'product-closed' }

    // แก้ได้เฉพาะข้อมูลทั่วไป — ห้ามแก้เงิน/ดอกเบี้ย/สถานะผ่านทางนี้ (ต้องทำรายการการเงิน)
    p.customerName = String(data.customerName || p.customerName).trim()
    p.customerIdCard = String(data.customerIdCard || '').trim()
    if (data.typeId) p.typeId = String(data.typeId)
    p.detail = String(data.detail || p.detail).trim()
    p.desc = String(data.desc || '').trim()
    if (data.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(data.startDate))) {
      p.startDate = String(data.startDate)
    }
    p.updatedAt = nowStr_()
    updateObj_(TAB.PRODUCTS, p)
    var result = { ok: true, product: clean_(p) }
    commitOp_(rid, p.id, result)
    return result
  })
}

function productGet_(data, user) {
  var rows = readAll_(TAB.PRODUCTS)
  var p = null
  for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { p = rows[i]; break }
  if (!p) return { ok: false, error: 'not-found' }
  var sts = readAll_(TAB.STATEMENTS)
  var list = []
  for (var j = 0; j < sts.length; j++) {
    if (sts[j].productId === p.id) {
      var s = clean_(sts[j])
      s.income = Number(s.income); s.pay = Number(s.pay); s.profit = Number(s.profit)
      list.push(s)
    }
  }
  list.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1 })
  return { ok: true, product: clean_(p), statements: list }
}

function productDelete_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'product.delete', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    if (!requireAdmin_(user)) return { ok: false, error: 'forbidden' }
    var rows = readAll_(TAB.PRODUCTS)
    var p = null
    for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { p = rows[i]; break }
    if (!p) return { ok: false, error: 'not-found' }
    var sts = readAll_(TAB.STATEMENTS)
    var hasSt = false
    for (var j = 0; j < sts.length; j++) if (sts[j].productId === p.id) { hasSt = true; break }
    if (hasSt) return { ok: false, error: 'has-statements' }
    var sh = ss_().getSheetByName(TAB.PRODUCTS)
    sh.deleteRow(p._row)
    var result = { ok: true }
    commitOp_(rid, p.id, result)
    return result
  })
}

/* ---------- รายการการเงินของสินค้า ---------- */

function financeOp_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'finance.' + data.op, function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var op = String(data.op || '')
    var allowed = ['interest', 'redeem', 'increase', 'reduce', 'sale']
    if (allowed.indexOf(op) < 0) return { ok: false, error: 'invalid-op' }

    var rows = readAll_(TAB.PRODUCTS)
    var p = null
    for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { p = rows[i]; break }
    if (!p) return { ok: false, error: 'not-found' }
    if (Number(p.status) === 0) return { ok: false, error: 'product-closed' }

    var before = clean_(p) // snapshot สำหรับการกลับรายการ
    var price = Number(p.price), interest = Number(p.interest), due = Number(p.due)
    var date = String(data.date || todayStr_()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid-date' }

    var st = {
      id: uuid_(), productId: p.id, type: op, date: date,
      income: 0, pay: 0, profit: 0,
      priceAfter: price, interestAfter: interest, dueAfter: due,
      endDateAfter: p.endDate, closeStatusAfter: '',
      note: String(data.note || '').trim(), requestId: rid,
      createdBy: user.id, createdAt: nowStr_(), void: '', voidOf: ''
    }

    if (op === 'interest') {
      // รับดอกเบี้ย: จ่ายดอกเข้าร้าน (profit), เลื่อนวันครบกำหนดตามงวด
      var amount = toIntBaht(data.amount)
      if (amount === null || amount < 0) return { ok: false, error: 'invalid-amount' }
      st.profit = amount
      st.endDateAfter = calEndDate(due, p.endDate)
    } else if (op === 'redeem') {
      // ไถ่ถอน: รับเงินต้น + ดอกค้างชำระ, ปิดสินค้า
      var amount2 = toIntBaht(data.amount)
      if (amount2 === null || amount2 < 0) return { ok: false, error: 'invalid-amount' }
      st.income = price
      st.profit = amount2
      st.closeStatusAfter = 'redeem'
    } else if (op === 'increase') {
      // เพิ่มต้น: ร้านจ่ายเพิ่ม, ต้นเพิ่ม, คำนวณดอกใหม่จากต้นใหม่ (สูตรเดิม)
      var inc = toIntBaht(data.amount)
      if (inc === null || inc <= 0) return { ok: false, error: 'invalid-amount' }
      st.pay = inc
      st.priceAfter = price + inc
      st.interestAfter = calInterest(price + inc)
      st.endDateAfter = calEndDate(due, p.endDate)
    } else if (op === 'reduce') {
      // ลดต้น: ร้านรับคืน, ต้นลด, ดอกใหม่จากต้นใหม่
      var red = toIntBaht(data.amount)
      if (red === null || red <= 0 || red > price) return { ok: false, error: 'invalid-amount' }
      st.income = red
      st.priceAfter = price - red
      st.interestAfter = calInterest(price - red)
    } else if (op === 'sale') {
      // ขายสินค้า: ขายได้เท่าไหร่ (income=ต้น, profit=ส่วนต่าง)
      var sale = toIntBaht(data.amount)
      if (sale === null || sale <= 0) return { ok: false, error: 'invalid-amount' }
      st.income = price
      st.profit = sale - price
      st.closeStatusAfter = 'sale'
    }

    // เขียน statement ก่อน แล้วอัปเดตสินค้า (idempotent ด้วย _row)
    appendObj_(TAB.STATEMENTS, st)

    p.price = Number(st.priceAfter)
    p.interest = Number(st.interestAfter)
    if (op === 'interest' || op === 'increase') p.endDate = st.endDateAfter
    if (op === 'redeem' || op === 'sale') {
      p.status = 0
      p.closeStatus = st.closeStatusAfter
    }
    p.updatedAt = nowStr_()
    updateObj_(TAB.PRODUCTS, p)

    var result = { ok: true, statement: st, product: clean_(p), before: before }
    commitOp_(rid, p.id, result)
    return result
  })
}

/* ---------- กลับรายการ (void) ---------- */

function statementVoid_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'statement.void', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    if (!requireAdmin_(user)) return { ok: false, error: 'forbidden' }
    var sts = readAll_(TAB.STATEMENTS)
    var orig = null
    for (var i = 0; i < sts.length; i++) if (sts[i].id === data.id) { orig = sts[i]; break }
    if (!orig) return { ok: false, error: 'not-found' }
    if (String(orig.void) === 'TRUE' || String(orig.void) === 'true') return { ok: false, error: 'already-void' }

    // รายการกลับ: ติดลบ แล้วกู้สถานะสินค้ากลับก่อนทำรายการนั้น (ใช้ priceBefore จาก Operations)
    var before = null
    var ops = readAll_(TAB.OPERATIONS)
    for (var k = 0; k < ops.length; k++) {
      if (ops[k].requestId === orig.requestId && ops[k].resultJson) {
        try {
          var r = JSON.parse(ops[k].resultJson)
          if (r.before) before = r.before
        } catch (err) { }
        break
      }
    }

    var reverse = {
      id: uuid_(), productId: orig.productId, type: orig.type, date: todayStr_(),
      income: -Number(orig.income), pay: -Number(orig.pay), profit: -Number(orig.profit),
      priceAfter: orig.priceAfter, interestAfter: orig.interestAfter, dueAfter: orig.dueAfter,
      endDateAfter: orig.endDateAfter, closeStatusAfter: orig.closeStatusAfter,
      note: 'กลับรายการ #' + String(orig.id).slice(0, 8), requestId: rid,
      createdBy: user.id, createdAt: nowStr_(), void: '', voidOf: orig.id
    }
    appendObj_(TAB.STATEMENTS, reverse)

    // ทำเครื่องหมายรายการเดิมว่าถูกกลับรายการแล้ว
    orig.void = 'TRUE'
    orig.voidOf = reverse.id
    updateObj_(TAB.STATEMENTS, orig)

    // กู้สินค้ากลับสถานะก่อนรายการ (ถ้ามี snapshot)
    var productResult = null
    if (before && before.id) {
      var rows = readAll_(TAB.PRODUCTS)
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].id === before.id) {
          rows[j].price = before.price
          rows[j].interest = before.interest
          rows[j].endDate = before.endDate
          rows[j].status = before.status
          rows[j].closeStatus = before.closeStatus
          rows[j].updatedAt = nowStr_()
          updateObj_(TAB.PRODUCTS, rows[j])
          productResult = clean_(rows[j])
          break
        }
      }
    }

    var result = { ok: true, reverse: reverse, product: productResult }
    commitOp_(rid, orig.id, result)
    return result
  })
}

/* ---------- บัญชีร้าน ---------- */

function accountingAdd_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'accounting.add', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var date = String(data.date || todayStr_()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid-date' }
    var title = String(data.title || '').trim()
    if (!title) return { ok: false, error: 'invalid-title' }
    var income = toIntBaht(data.income || 0)
    var pay = toIntBaht(data.pay || 0)
    if (income === null || pay === null) return { ok: false, error: 'invalid-amount' }
    if (income === 0 && pay === 0) return { ok: false, error: 'invalid-amount' }
    if (income > 0 && pay > 0) return { ok: false, error: 'both-sides' }

    var row = {
      id: uuid_(), date: date, title: title, income: income, pay: pay,
      note: String(data.note || '').trim(), requestId: rid,
      createdBy: user.id, createdAt: nowStr_(), void: '', voidOf: ''
    }
    appendObj_(TAB.ACCOUNTING, row)
    var result = { ok: true, entry: row }
    commitOp_(rid, row.id, result)
    return result
  })
}

function accountingVoid_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'accounting.void', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    if (!requireAdmin_(user)) return { ok: false, error: 'forbidden' }
    var rows = readAll_(TAB.ACCOUNTING)
    var orig = null
    for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { orig = rows[i]; break }
    if (!orig) return { ok: false, error: 'not-found' }
    if (String(orig.void) === 'TRUE' || String(orig.void) === 'true') return { ok: false, error: 'already-void' }

    var reverse = {
      id: uuid_(), date: todayStr_(), title: 'กลับรายการ: ' + orig.title,
      income: -Number(orig.income), pay: -Number(orig.pay),
      note: '', requestId: rid, createdBy: user.id, createdAt: nowStr_(), void: '', voidOf: orig.id
    }
    appendObj_(TAB.ACCOUNTING, reverse)
    orig.void = 'TRUE'
    orig.voidOf = reverse.id
    updateObj_(TAB.ACCOUNTING, orig)
    var result = { ok: true, reverse: reverse }
    commitOp_(rid, orig.id, result)
    return result
  })
}

/* ---------- เจ้าหนี้ ---------- */

function creditorSave_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'creditor.save', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var name = String(data.name || '').trim()
    if (!name) return { ok: false, error: 'invalid-name' }
    var note = String(data.note || '').trim()
    var result
    if (data.id) {
      var rows = readAll_(TAB.CREDITORS)
      var found = null
      for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { found = rows[i]; break }
      if (!found) return { ok: false, error: 'not-found' }
      found.name = name
      found.note = note
      updateObj_(TAB.CREDITORS, found)
      result = { ok: true, creditor: clean_(found) }
    } else {
      var c = { id: uuid_(), name: name, note: note, createdBy: user.id, createdAt: nowStr_() }
      appendObj_(TAB.CREDITORS, c)
      result = { ok: true, creditor: clean_(c) }
    }
    commitOp_(rid, data.id || result.creditor.id, result)
    return result
  })
}

function creditorMoveAdd_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'creditorMove.add', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var creditors = readAll_(TAB.CREDITORS)
    var found = null
    for (var i = 0; i < creditors.length; i++) if (creditors[i].id === data.creditorId) { found = creditors[i]; break }
    if (!found) return { ok: false, error: 'not-found' }
    var date = String(data.date || todayStr_()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid-date' }
    var borrow = toIntBaht(data.borrow || 0)
    var refund = toIntBaht(data.refund || 0)
    if (borrow === null || refund === null) return { ok: false, error: 'invalid-amount' }
    if (borrow > 0 && refund > 0) return { ok: false, error: 'both-sides' }
    if (borrow === 0 && refund === 0) return { ok: false, error: 'invalid-amount' }

    var m = {
      id: uuid_(), creditorId: found.id, date: date, borrow: borrow, refund: refund,
      note: String(data.note || '').trim(), requestId: rid,
      createdBy: user.id, createdAt: nowStr_()
    }
    appendObj_(TAB.CREDITOR_MOVES, m)
    var result = { ok: true, move: m }
    commitOp_(rid, m.id, result)
    return result
  })
}

/* ---------- รายงาน ---------- */

function reportRange_(data, user) {
  var start = String(data.start || '')
  var end = String(data.end || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { ok: false, error: 'invalid-range' }
  }
  var products = readAll_(TAB.PRODUCTS)
  var byId = {}
  products.forEach(function (p) { byId[p.id] = p })

  var sts = readAll_(TAB.STATEMENTS)
  var statements = []
  for (var i = 0; i < sts.length; i++) {
    var s = sts[i]
    var v = String(s.void) === 'TRUE' || String(s.void) === 'true'
    if (String(s.date) < start || String(s.date) > end) continue
    if (v && s.voidOf) continue // รายการกลับถูกนับที่ตัวกลับเอง
    var p = byId[s.productId]
    statements.push({
      id: s.id, productId: s.productId, type: s.type, date: String(s.date),
      income: Number(s.income), pay: Number(s.pay), profit: Number(s.profit),
      void: v, productNo: p ? Number(p.productNo) : 0, customerName: p ? p.customerName : '',
      detail: p ? p.detail : '', createdBy: s.createdBy
    })
  }

  var acc = readAll_(TAB.ACCOUNTING)
  var accounting = []
  for (var j = 0; j < acc.length; j++) {
    var a = acc[j]
    if (String(a.date) < start || String(a.date) > end) continue
    accounting.push({
      id: a.id, date: String(a.date), title: a.title,
      income: Number(a.income), pay: Number(a.pay),
      void: String(a.void) === 'TRUE' || String(a.void) === 'true'
    })
  }

  var sum = { cashIn: 0, cashOut: 0, profit: 0, accIn: 0, accOut: 0 }
  statements.forEach(function (s) {
    sum.cashIn += s.income + s.profit
    sum.cashOut += s.pay
    sum.profit += s.profit
  })
  accounting.forEach(function (a) {
    sum.accIn += a.income
    sum.accOut += a.pay
  })

  return { ok: true, statements: statements, accounting: accounting, summary: sum }
}

/* ---------- ตั้งค่า ---------- */

function typeSave_(data, user) {
  var name = String(data.name || '').trim()
  if (!name) return { ok: false, error: 'invalid-name' }
  if (data.id) {
    var rows = readAll_(TAB.TYPES)
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === data.id) {
        rows[i].name = name
        rows[i].icon = String(data.icon || '')
        updateObj_(TAB.TYPES, rows[i])
        return { ok: true, type: clean_(rows[i]) }
      }
    }
    return { ok: false, error: 'not-found' }
  }
  var t = { id: uuid_(), name: name, icon: String(data.icon || '') }
  appendObj_(TAB.TYPES, t)
  return { ok: true, type: clean_(t) }
}

function dueSave_(data, user) {
  var due = Number(data.due)
  if (isNaN(due) || due < 0) return { ok: false, error: 'invalid-due' }
  var row = {
    id: data.id || 'due-' + due, due: due, unit: String(data.unit || 'day'),
    title: String(data.title || '').trim(), color: String(data.color || 'grey')
  }
  if (!row.title) return { ok: false, error: 'invalid-title' }
  var rows = readAll_(TAB.DUE)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === row.id) {
      rows[i].due = row.due
      rows[i].unit = row.unit
      rows[i].title = row.title
      rows[i].color = row.color
      updateObj_(TAB.DUE, rows[i])
      return { ok: true, due: clean_(rows[i]) }
    }
  }
  appendObj_(TAB.DUE, row)
  return { ok: true, due: clean_(row) }
}

/* ---------- ผู้ใช้ ---------- */

function userSave_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'user.save', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    if (!requireAdmin_(user)) return { ok: false, error: 'forbidden' }
    var name = String(data.name || '').trim()
    var email = String(data.email || '').trim().toLowerCase()
    if (!name || email.indexOf('@') < 0) return { ok: false, error: 'invalid-input' }
    var role = data.role === 'admin' ? 'admin' : 'staff'

    if (data.id) {
      // แก้ไข: ห้าม admin ตัวเองถอดสิทธิ์ตัวเอง
      if (data.id === user.id && role !== 'admin') return { ok: false, error: 'self-demote' }
      var rows = readAll_(TAB.EMPLOYEES)
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === data.id) {
          rows[i].name = name
          rows[i].email = email
          rows[i].role = role
          rows[i].active = data.active === false || data.active === 0 ? 0 : 1
          updateObj_(TAB.EMPLOYEES, rows[i])
          var result = { ok: true, user: publicUser_(rows[i]) }
          commitOp_(rid, data.id, result)
          return result
        }
      }
      return { ok: false, error: 'not-found' }
    }

    // เพิ่มใหม่: ต้องระบุรหัสผ่าน (hash ทันที ไม่เก็บ plaintext)
    var password = String(data.password || '')
    if (password.length < 6) return { ok: false, error: 'weak-password' }
    var rows2 = readAll_(TAB.EMPLOYEES)
    for (var k = 0; k < rows2.length; k++) {
      if (String(rows2[k].email || '').toLowerCase() === email) return { ok: false, error: 'duplicate-email' }
    }
    var salt = randomSalt_()
    var u = {
      id: uuid_(), name: name, email: email,
      passwordHash: hashPassword(password, salt, PBKDF2_ITER), salt: salt,
      role: role, avatar: '', active: 1, createdAt: nowStr_()
    }
    appendObj_(TAB.EMPLOYEES, u)
    var result2 = { ok: true, user: publicUser_(u) }
    commitOp_(rid, u.id, result2)
    return result2
  })
}

function userPassword_(data, user) {
  // เปลี่ยนรหัสผ่านตัวเอง (หรือ admin เปลี่ยนให้ผู้อื่น)
  var targetId = (requireAdmin_(user) && data.id) ? data.id : user.id
  var newPassword = String(data.newPassword || '')
  if (newPassword.length < 6) return { ok: false, error: 'weak-password' }
  var current = String(data.currentPassword || '')
  var rows = readAll_(TAB.EMPLOYEES)
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === targetId) {
      // ถ้าเปลี่ยนรหัสตัวเอง ต้องยืนยันรหัสเดิม
      if (targetId === user.id) {
        if (hashPassword(current, String(rows[i].salt), PBKDF2_ITER) !== String(rows[i].passwordHash)) {
          return { ok: false, error: 'invalid-credential' }
        }
      }
      var salt = randomSalt_()
      rows[i].salt = salt
      rows[i].passwordHash = hashPassword(newPassword, salt, PBKDF2_ITER)
      updateObj_(TAB.EMPLOYEES, rows[i])
      return { ok: true }
    }
  }
  return { ok: false, error: 'not-found' }
}

/* ---------- ตัวช่วยเล็ก ---------- */

function clean_(obj) {
  var o = {}
  for (var k in obj) if (k !== '_row') o[k] = obj[k]
  return o
}

function existingResult_(op) {
  var res = {}
  try { res = JSON.parse(op.resultJson) } catch (err) { }
  res.replayed = true
  return res
}
