var __tables = {}
var __initialTables = {}
var __cache = {}
var __initialCache = {}
var __initialCacheExpiry = {}
var __cacheExpiry = {}
var __db = null
var __requestQueue = Promise.resolve()

function __sheet(name) {
  if (!__tables[name]) return null
  var rows = __tables[name]
  return {
    appendRow: function (row) { rows.push(row.slice()) },
    getLastRow: function () { return rows.length },
    getMaxRows: function () { return Math.max(1000, rows.length) },
    setFrozenRows: function () {},
    getDataRange: function () {
      return { getValues: function () { return rows.map(function (row) { return row.slice() }) } }
    },
    getRange: function (startRow, startColumn, numRows, numColumns) {
      return {
        setValues: function (values) {
          for (var rowIndex = 0; rowIndex < numRows; rowIndex++) {
            while (rows.length < startRow + rowIndex) rows.push([])
            var row = rows[startRow + rowIndex - 1]
            while (row.length < startColumn + numColumns - 1) row.push('')
            for (var columnIndex = 0; columnIndex < numColumns; columnIndex++) {
              row[startColumn + columnIndex - 1] = values[rowIndex][columnIndex]
            }
          }
        },
        setNumberFormat: function () {}
      }
    },
    deleteRow: function (rowNumber) { rows.splice(rowNumber - 1, 1) }
  }
}

var SpreadsheetApp = {
  getActiveSpreadsheet: function () { return SpreadsheetApp },
  openById: function () { return SpreadsheetApp },
  getSheetByName: __sheet,
  insertSheet: function (name) { __tables[name] = []; return __sheet(name) },
  getUi: function () { return { alert: function () {} } }
}

var PropertiesService = {
  getScriptProperties: function () {
    return { getProperty: function () { return null }, setProperty: function () {} }
  }
}

var CacheService = {
  getScriptCache: function () {
    return {
      get: function (key) {
        if (__cacheExpiry[key] && __cacheExpiry[key] <= Date.now()) {
          delete __cache[key]
          delete __cacheExpiry[key]
          return null
        }
        return Object.prototype.hasOwnProperty.call(__cache, key) ? __cache[key] : null
      },
      put: function (key, value, ttl) {
        __cache[key] = String(value)
        __cacheExpiry[key] = Date.now() + (Number(ttl) || 0) * 1000
      },
      remove: function (key) {
        delete __cache[key]
        delete __cacheExpiry[key]
      }
    }
  }
}

var LockService = {
  getScriptLock: function () { return { tryLock: function () { return true }, releaseLock: function () {} } }
}

var Utilities = {
  getUuid: function () { return crypto.randomUUID() },
  formatDate: function (date, timezone, format) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date)
    var values = {}
    parts.forEach(function (part) { values[part.type] = part.value })
    if (format === 'yyyy-MM-dd') return values.year + '-' + values.month + '-' + values.day
    if (format === 'yyyy-MM-dd HH:mm:ss') {
      return values.year + '-' + values.month + '-' + values.day + ' ' + values.hour + ':' + values.minute + ':' + values.second
    }
    throw new Error('Unsupported date format')
  }
}

var Logger = { log: function (message) { console.error(message) } }
var ContentService = { MimeType: { JSON: 'application/json' } }
var ADMIN_EMAIL = 'admin@example.com'

async function __hashPassword(password, saltHex) {
  var salt = new Uint8Array(saltHex.match(/.{2}/g).map(function (byte) { return parseInt(byte, 16) }))
  var key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(strBytes(String(password))),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    256
  )
  return Array.from(new Uint8Array(bits)).map(function (byte) { return byte.toString(16).padStart(2, '0') }).join('')
}

async function __tokenKey(token) {
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)))
  return Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, '0') }).join('')
}

function __withPreparedHashes(hashes, salt, callback) {
  var originalHashPassword = hashPassword
  var originalRandomSalt = randomSalt_
  hashPassword = function (password, saltHex) {
    var value = hashes[String(password) + '\u0000' + String(saltHex)]
    if (!value) throw new Error('Password hash was not prepared')
    return value
  }
  if (salt) randomSalt_ = function () { return salt }
  try { return callback() } finally {
    hashPassword = originalHashPassword
    randomSalt_ = originalRandomSalt
  }
}

async function __login(data) {
  var email = String(data.email || '').trim().toLowerCase()
  var password = String(data.password || '')
  if (!email || !password) return { ok: false, error: 'invalid-input' }

  var cache = CacheService.getScriptCache()
  var failKey = 'fail_' + email
  var fails = Number(cache.get(failKey) || 0)
  if (fails >= 5) return { ok: false, error: 'rate-limited' }

  var employees = readAll_(TAB.EMPLOYEES)
  var user = null
  for (var index = 0; index < employees.length; index++) {
    if (String(employees[index].email || '').toLowerCase() === email) {
      user = employees[index]
      break
    }
  }
  if (!user || String(user.active) === 'false' || Number(user.active) === 0) {
    cache.put(failKey, String(fails + 1), 900)
    return { ok: false, error: 'invalid-credential' }
  }

  var hash = await __hashPassword(password, String(user.salt))
  var mismatch = hash.length ^ String(user.passwordHash).length
  for (var i = 0; i < hash.length; i++) mismatch |= hash.charCodeAt(i) ^ (String(user.passwordHash).charCodeAt(i) || 0)
  if (mismatch !== 0) {
    cache.put(failKey, String(fails + 1), 900)
    return { ok: false, error: 'invalid-credential' }
  }
  cache.remove(failKey)
  var token = uuid_()
  cache.put('tk_' + await __tokenKey(token), user.id, TOKEN_TTL)
  return { ok: true, token: token, user: publicUser_(user) }
}

async function __route(payload) {
  var data = payload.data || {}
  if (payload.action === 'login') return __login(data)
  if (payload.token) payload.token = await __tokenKey(payload.token)

  if (payload.action === 'user.save' && !data.id) {
    var actingUser = auth_(payload.token)
    var password = String(data.password || '')
    if (!actingUser || !requireAdmin_(actingUser) || password.length < 6) return route_(payload)
    var userSalt = randomSalt_()
    var userHash = await __hashPassword(password, userSalt)
    var userHashes = {}
    userHashes[password + '\u0000' + userSalt] = userHash
    return __withPreparedHashes(userHashes, userSalt, function () { return route_(payload) })
  }

  if (payload.action === 'user.password') {
    var currentUser = auth_(payload.token)
    var newPassword = String(data.newPassword || '')
    if (!currentUser || newPassword.length < 6) return route_(payload)

    var targetId = currentUser.role === 'admin' && data.id ? data.id : currentUser.id
    var employees = readAll_(TAB.EMPLOYEES)
    var target = employees.find(function (employee) { return employee.id === targetId })
    if (!target) return route_(payload)

    var newSalt = randomSalt_()
    var prepared = {}
    prepared[newPassword + '\u0000' + newSalt] = await __hashPassword(newPassword, newSalt)
    if (targetId === currentUser.id) {
      var currentPassword = String(data.currentPassword || '')
      prepared[currentPassword + '\u0000' + String(target.salt)] = await __hashPassword(currentPassword, String(target.salt))
    }
    return __withPreparedHashes(prepared, newSalt, function () { return route_(payload) })
  }

  return route_(payload)
}

async function __loadState(db) {
  __db = db
  __tables = {}
  __initialTables = {}
  __cache = {}
  __initialCache = {}
  __initialCacheExpiry = {}
  __cacheExpiry = {}

  Object.keys(COLS).forEach(function (name) {
    __tables[name] = [COLS[name].slice()]
  })

  var tableNames = Object.keys(COLS)
  for (var tableIndex = 0; tableIndex < tableNames.length; tableIndex++) {
    var tableName = tableNames[tableIndex]
    var rows = await __readAll(db, 'SELECT * FROM "' + tableName + '" ORDER BY rowid')
    rows.forEach(function (record) {
      __tables[tableName].push(COLS[tableName].map(function (column) {
        return record[column] === undefined || record[column] === null ? '' : record[column]
      }))
    }
    )
  }
  Object.keys(__tables).forEach(function (name) {
    __initialTables[name] = __tables[name].map(function (row) { return row.slice() })
  })

  var cacheRows = await __readAll(db, 'SELECT cache_key, cache_value, expires_at FROM PawnAuth')
  var now = Date.now()
  cacheRows.forEach(function (row) {
    __initialCache[row.cache_key] = row.cache_value
    __initialCacheExpiry[row.cache_key] = Number(row.expires_at)
    if (Number(row.expires_at) > now) {
      __cache[row.cache_key] = row.cache_value
      __cacheExpiry[row.cache_key] = Number(row.expires_at)
    }
  })
}

async function __readAll(db, sql) {
  var results = []
  var offset = 0
  while (true) {
    var page = await db.prepare(sql + ' LIMIT 500 OFFSET ?').bind(offset).all()
    var rows = page.results || []
    results = results.concat(rows)
    if (rows.length < 500) return results
    offset += rows.length
  }
}

function __recordKey(columns, row) {
  return String(row[0] === undefined || row[0] === null ? '' : row[0])
}

async function __flushState() {
  var statements = []
  Object.keys(COLS).forEach(function (name) {
    var columns = COLS[name]
    var keyColumn = name === 'Config' ? 'key' : (name === 'Operations' ? 'requestId' : 'id')
    var keyIndex = columns.indexOf(keyColumn)
    var initial = __initialTables[name] || []
    var current = __tables[name] || []
    var before = Object.create(null)
    var after = Object.create(null)
    for (var i = 1; i < initial.length; i++) {
      var oldKey = String(initial[i][keyIndex] === undefined ? '' : initial[i][keyIndex])
      before[oldKey] = initial[i]
    }
    for (var j = 1; j < current.length; j++) {
      var key = String(current[j][keyIndex] === undefined ? '' : current[j][keyIndex])
      after[key] = current[j]
    }

    Object.keys(before).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(after, key)) {
        statements.push(__db.prepare('DELETE FROM "' + name + '" WHERE "' + keyColumn + '" = ?').bind(key))
      }
    })
    Object.keys(after).forEach(function (key) {
      var row = after[key]
      var previous = before[key]
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) {
        var values = row.map(function (value) { return value === undefined ? '' : value })
        var placeholders = columns.map(function () { return '?' }).join(', ')
        var updates = columns
          .filter(function (column) { return column !== keyColumn })
          .map(function (column) { return '"' + column + '" = excluded."' + column + '"' })
          .join(', ')
        var sql = 'INSERT INTO "' + name + '" (' +
          columns.map(function (column) { return '"' + column + '"' }).join(', ') +
          ') VALUES (' + placeholders + ') ON CONFLICT("' + keyColumn + '") DO UPDATE SET ' + updates
        var statement = __db.prepare(sql)
        statements.push(statement.bind.apply(statement, values))
      }
    })
  })

  var authTable = 'PawnAuth'
  Object.keys(__initialCache).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(__cache, key)) {
      statements.push(__db.prepare('DELETE FROM "' + authTable + '" WHERE cache_key = ?').bind(key))
    }
  })
  Object.keys(__cache).forEach(function (key) {
    if (__cache[key] !== __initialCache[key] || __cacheExpiry[key] !== __initialCacheExpiry[key]) {
      statements.push(__db.prepare(
        'INSERT INTO "' + authTable + '" (cache_key, cache_value, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(cache_key) DO UPDATE SET cache_value = excluded.cache_value, expires_at = excluded.expires_at'
      ).bind(key, __cache[key], __cacheExpiry[key] || 0))
    }
  })

  for (var start = 0; start < statements.length; start += 100) {
    await __db.batch(statements.slice(start, start + 100))
  }
}

function __json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    }
  })
}

async function __setup(request, env, origin) {
  var secret = env.SETUP_SECRET
  if (!secret || request.headers.get('Authorization') !== 'Bearer ' + secret) {
    return __json({ ok: false, error: 'forbidden' }, 403, origin)
  }

  var body
  try { body = await request.json() } catch (error) {
    return __json({ ok: false, error: 'invalid-json' }, 400, origin)
  }
  var email = String(body.email || '').trim().toLowerCase()
  var password = String(body.password || '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    return __json({ ok: false, error: 'invalid-input' }, 400, origin)
  }

  var existing = await env.DB.prepare("SELECT 1 FROM Employees LIMIT 1").first()
  if (existing) {
    return __json({ ok: false, error: 'already-setup' }, 409, origin)
  }

  var salt = randomSalt_()
  var user = {
    id: uuid_(), name: String(body.name || 'ผู้จัดการ').trim() || 'ผู้จัดการ',
    email: email, passwordHash: await __hashPassword(password, salt),
    salt: salt, role: 'admin', avatar: '', active: 1, createdAt: nowStr_()
  }
  var statements = [
    env.DB.prepare('INSERT INTO Employees (id, name, email, passwordHash, salt, role, avatar, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      user.id, user.name, user.email, user.passwordHash, user.salt, user.role, user.avatar, user.active, user.createdAt
    ),
    env.DB.prepare('INSERT INTO Config ("key", value) VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET value = excluded.value').bind(
      'setupDone', '1'
    )
  ]
  var existingTypes = await env.DB.prepare('SELECT 1 FROM Types LIMIT 1').first()
  var defaultTypes = ['ทอง', 'นาฬิกา', 'มือถือ', 'สิ่งของอื่น ๆ']
  if (!existingTypes) {
    defaultTypes.forEach(function (name) {
      statements.push(env.DB.prepare('INSERT INTO Types (id, name, icon) VALUES (?, ?, ?)').bind(uuid_(), name, ''))
    })
  }
  var existingDue = await env.DB.prepare('SELECT 1 FROM Due LIMIT 1').first()
  var defaultDue = [
    ['due-30', 30, 'month', 'รายเดือน', 'green'],
    ['due-15', 15, 'day', '15 วัน', 'amber'],
    ['due-10', 10, 'day', '10 วัน', 'pink'],
    ['due-0', 0, 'none', 'ขายสินค้า', 'grey']
  ]
  if (!existingDue) {
    defaultDue.forEach(function (due) {
      statements.push(env.DB.prepare('INSERT INTO Due (id, due, unit, title, color) VALUES (?, ?, ?, ?, ?)').bind.apply(null, due))
    })
  }
  try {
    await env.DB.batch(statements)
  } catch (error) {
    console.error('D1 initial setup failed', error)
    return __json({ ok: false, error: 'setup-failed' }, 500, origin)
  }
  return __json({ ok: true, setupDone: true }, 200, origin)
}

async function __handle(request, env) {
  var origin = request.headers.get('Origin') || '*'
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin'
      }
    })
  }
  if (request.method !== 'POST') return __json({ ok: false, error: 'method-not-allowed' }, 405, origin)
  if (!env.DB) return __json({ ok: false, error: 'database-not-configured' }, 503, origin)

  var pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/'
  if (pathname === '/setup') return __setup(request, env, origin)
  if (pathname !== '/' && pathname !== '/api') return __json({ ok: false, error: 'not-found' }, 404, origin)

  var payload
  try { payload = await request.json() } catch (error) {
    return __json({ ok: false, error: 'invalid-json' }, 400, origin)
  }
  var result = await env.DB.prepare('SELECT 1 FROM Employees LIMIT 1').first()
  if (result === null) return __json({ ok: true, setupDone: false }, 200, origin)

  await __loadState(env.DB)
  var response = await __route(payload)
  await __flushState()
  return __json(response, 200, origin)
}

async function __run(request, env) {
  var running = __requestQueue.then(function () { return __handle(request, env) })
  __requestQueue = running.then(function () {}, function () {})
  return running
}

export default {
  fetch: function (request, env) {
    return __run(request, env).catch(function (error) {
      console.error('Pawnshop Worker request failed', error)
      return __json({ ok: false, error: 'server-error' }, 500, request.headers.get('Origin') || '*')
    })
  }
}


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


/* =========================================================
 * pbkdf2.js — PBKDF2-HMAC-SHA256 (pure JS, ไม่พึ่งไลบรารี)
 * สำหรับใช้ใน Google Apps Script (ไม่มี crypto แบบ PBKDF2 ให้)
 * ทดสอบกับ test vectors มาตรฐานแล้ว (ดู test-logic.js)
 * ========================================================= */

/* ---------- SHA-256 (pure JS) ---------- */
var SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]

function sha256Bytes(bytes) {
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  var msg = bytes.slice()
  var bitLen = msg.length * 8
  msg.push(0x80)
  while (msg.length % 64 !== 56) msg.push(0)
  // ความยาวเป็นบิต (แกน 64 บิต — ใช้เฉพาะ 32 บิตล่าง ก็พอสำหรับข้อมูลขนาดปกติ)
  var hi = Math.floor(bitLen / 4294967296)
  var lo = bitLen >>> 0
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255)
  msg.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)

  var w = new Array(64)
  var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)) }
  for (var off = 0; off < msg.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      var j = off + i * 4
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]
    }
    for (var i2 = 16; i2 < 64; i2++) {
      var s0 = rotr(w[i2 - 15], 7) ^ rotr(w[i2 - 15], 18) ^ (w[i2 - 15] >>> 3)
      var s1 = rotr(w[i2 - 2], 17) ^ rotr(w[i2 - 2], 19) ^ (w[i2 - 2] >>> 10)
      w[i2] = (w[i2 - 16] + s0 + w[i2 - 7] + s1) >>> 0
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (var t = 0; t < 64; t++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      var ch = (e & f) ^ (~e & g)
      var t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  var out = []
  for (var k = 0; k < 8; k++) {
    out.push((H[k] >>> 24) & 255, (H[k] >>> 16) & 255, (H[k] >>> 8) & 255, H[k] & 255)
  }
  return out
}

function strBytes(s) {
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 128) out.push(c)
    else {
      // UTF-8 encode
      if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63))
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63))
    }
  }
  return out
}

function bytesHex(bytes) {
  var s = ''
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return s
}

function hmacSha256(keyBytes, dataBytes) {
  var block = 64
  var k = keyBytes.slice()
  if (k.length > block) k = sha256Bytes(k)
  while (k.length < block) k.push(0)
  var ipad = [], opad = []
  for (var i = 0; i < block; i++) {
    ipad.push(k[i] ^ 0x36)
    opad.push(k[i] ^ 0x5c)
  }
  return sha256Bytes(opad.concat(sha256Bytes(ipad.concat(dataBytes))))
}

/* ---------- PBKDF2-HMAC-SHA256 ---------- */

function pbkdf2Sha256(password, salt, iterations, dkLen) {
  var pw = strBytes(String(password))
  var st = (salt instanceof Array) ? salt.slice() : strBytes(String(salt)) // salt ต้องเป็น bytes อยู่แล้ว
  var blocks = Math.ceil(dkLen / 32)
  var dk = []
  for (var b = 1; b <= blocks; b++) {
    // U1 = PRF(P, S || INT(b))
    var u = hmacSha256(pw, st.concat([(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255]))
    var t = u.slice()
    for (var i = 1; i < iterations; i++) {
      u = hmacSha256(pw, u)
      for (var j = 0; j < t.length; j++) t[j] ^= u[j]
    }
    dk = dk.concat(t)
  }
  return dk.slice(0, dkLen)
}

function hashPassword(password, saltHex, iterations) {
  // แปลง salt (hex string) เป็น bytes ก่อนใช้
  var sb = []
  for (var i = 0; i < saltHex.length; i += 2) sb.push(parseInt(saltHex.substr(i, 2), 16))
  return bytesHex(pbkdf2Sha256(password, sb, iterations || 10000, 32))
}


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
  if (action === 'accounting.delete') return accountingDelete_(data, user, req.requestId)
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
    var dueOptions = readAll_(TAB.DUE)
    var validDue = false
    for (var i = 0; i < dueOptions.length; i++) {
      if (Number(dueOptions[i].due) === out.due) { validDue = true; break }
    }
    if (!isFinite(out.due) || Math.floor(out.due) !== out.due || !validDue) return { error: 'due' }
    out.startDate = String(data.startDate || todayStr_()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.startDate)) return { error: 'startDate' }
    out.endDate = calEndDate(out.due, out.startDate)
    out.desc = String(data.desc || '').trim()
    if (data.productNo === undefined || data.productNo === null || data.productNo === '') {
      out.productNo = nextProductNo_()
    } else {
      out.productNo = toIntBaht(data.productNo)
      if (out.productNo === null || out.productNo <= 0) return { error: 'productNo' }
      var products = readAll_(TAB.PRODUCTS)
      for (var i = 0; i < products.length; i++) {
        if (Number(products[i].productNo) === out.productNo) return { error: 'productNo-taken' }
      }
    }
  }
  return { value: out }
}

function productCreate_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'product.create', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    var v = validateProduct_(data, true)
    if (v.error) return { ok: false, error: 'invalid-' + v.error }

    var productNo = v.value.productNo
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

    var productNo = data.productNo === undefined ? Number(p.productNo) : toIntBaht(data.productNo)
    if (productNo === null || productNo <= 0) return { ok: false, error: 'invalid-productNo' }
    for (var n = 0; n < rows.length; n++) {
      if (rows[n].id !== p.id && Number(rows[n].productNo) === productNo) return { ok: false, error: 'invalid-productNo-taken' }
    }

    var price = data.price === undefined ? Number(p.price) : toIntBaht(data.price)
    if (price === null || price <= 0) return { ok: false, error: 'invalid-price' }
    var interest = data.interest === undefined ? Number(p.interest) : toIntBaht(data.interest)
    if (interest === null || interest < 0) return { ok: false, error: 'invalid-interest' }
    var startDate = data.startDate === undefined ? String(p.startDate) : String(data.startDate)
    var endDate = data.endDate === undefined ? String(p.endDate) : String(data.endDate)
    function validDate(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      var parsed = dateParse(value)
      return !!parsed && dateFmt(parsed) === value
    }
    if (!validDate(startDate)) return { ok: false, error: 'invalid-startDate' }
    if (Number(p.due) === 0) {
      endDate = '0'
    } else if (!validDate(endDate)) {
      return { ok: false, error: 'invalid-endDate' }
    }

    var statements = readAll_(TAB.STATEMENTS)
    var productStatements = statements.filter(function (statement) { return statement.productId === p.id })
    var hasFinancialHistory = productStatements.some(function (statement) { return statement.type !== 'new' })
    var financialChanged = price !== Number(p.price) || interest !== Number(p.interest) ||
      startDate !== String(p.startDate) || endDate !== String(p.endDate)
    if (hasFinancialHistory && financialChanged) return { ok: false, error: 'product-has-history' }

    var openingStatement = null
    if (financialChanged) {
      for (var j = 0; j < productStatements.length; j++) {
        if (productStatements[j].type === 'new') { openingStatement = productStatements[j]; break }
      }
      if (!openingStatement) return { ok: false, error: 'missing-opening-statement' }
    }

    p.productNo = productNo
    p.customerName = String(data.customerName || p.customerName).trim()
    p.customerIdCard = String(data.customerIdCard || '').trim()
    if (data.typeId) p.typeId = String(data.typeId)
    p.detail = String(data.detail || p.detail).trim()
    p.desc = String(data.desc || '').trim()
    if (financialChanged) {
      p.price = price
      p.interest = interest
      p.startDate = startDate
      p.endDate = endDate
      openingStatement.date = startDate
      openingStatement.pay = price
      openingStatement.priceAfter = price
      openingStatement.interestAfter = interest
      openingStatement.endDateAfter = endDate
      updateObj_(TAB.STATEMENTS, openingStatement)
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

function accountingDelete_(data, user, requestId) {
  return withIdempotency_(requestId, user, 'accounting.delete', function (rid, existingOp) {
    if (existingOp) return existingResult_(existingOp)
    if (!requireAdmin_(user)) return { ok: false, error: 'forbidden' }
    var rows = readAll_(TAB.ACCOUNTING)
    var entry = null
    for (var i = 0; i < rows.length; i++) if (rows[i].id === data.id) { entry = rows[i]; break }
    if (!entry) return { ok: false, error: 'not-found' }
    var isVoided = String(entry.void).toLowerCase() === 'true'
    var hasLinkedEntry = !!entry.voidOf
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].voidOf === entry.id) { hasLinkedEntry = true; break }
    }
    if (isVoided || hasLinkedEntry) return { ok: false, error: 'linked-entry' }
    ss_().getSheetByName(TAB.ACCOUNTING).deleteRow(entry._row)
    var result = { ok: true }
    commitOp_(rid, entry.id, result)
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
    if (refund > 0) {
      var moves = readAll_(TAB.CREDITOR_MOVES)
      var outstanding = 0
      for (var j = 0; j < moves.length; j++) {
        if (moves[j].creditorId === found.id) outstanding += Number(moves[j].borrow) - Number(moves[j].refund)
      }
      if (refund > outstanding) return { ok: false, error: 'refund-exceeds-balance' }
    }

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
  if (!isFinite(due) || due < 0 || Math.floor(due) !== due) return { ok: false, error: 'invalid-due' }
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
