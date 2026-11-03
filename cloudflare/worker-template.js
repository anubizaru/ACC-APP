var __tables = {}
var __dirtyRows = {}
var __cache = {}
var __cacheExpiry = {}
var __dirtyCacheKeys = Object.create(null)
var __db = null
var __requestQueue = Promise.resolve()

function __rowKey(name, row) {
  var columns = COLS[name]
  var keyColumn = name === 'Config' ? 'key' : (name === 'Operations' ? 'requestId' : 'id')
  var index = columns.indexOf(keyColumn)
  return String(row[index] === undefined || row[index] === null ? '' : row[index])
}

function __markDirty(name, key, row) {
  if (!__dirtyRows[name]) __dirtyRows[name] = Object.create(null)
  __dirtyRows[name][key] = row
}

function __sheet(name) {
  if (!__tables[name]) return null
  var rows = __tables[name]
  return {
    appendRow: function (row) {
      var copy = row.slice()
      rows.push(copy)
      __markDirty(name, __rowKey(name, copy), copy)
    },
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
            var oldKey = __rowKey(name, row)
            while (row.length < startColumn + numColumns - 1) row.push('')
            for (var columnIndex = 0; columnIndex < numColumns; columnIndex++) {
              row[startColumn + columnIndex - 1] = values[rowIndex][columnIndex]
            }
            var newKey = __rowKey(name, row)
            if (oldKey !== newKey) __markDirty(name, oldKey, null)
            __markDirty(name, newKey, row)
          }
        },
        setNumberFormat: function () {}
      }
    },
    deleteRow: function (rowNumber) {
      var row = rows[rowNumber - 1]
      if (row && rowNumber > 1) __markDirty(name, __rowKey(name, row), null)
      rows.splice(rowNumber - 1, 1)
    }
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
          __dirtyCacheKeys[key] = true
          return null
        }
        return Object.prototype.hasOwnProperty.call(__cache, key) ? __cache[key] : null
      },
      put: function (key, value, ttl) {
        __cache[key] = String(value)
        __cacheExpiry[key] = Date.now() + (Number(ttl) || 0) * 1000
        __dirtyCacheKeys[key] = true
      },
      remove: function (key) {
        delete __cache[key]
        delete __cacheExpiry[key]
        __dirtyCacheKeys[key] = true
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

async function __loadState(db, requestedTables) {
  __db = db
  __tables = {}
  __dirtyRows = {}
  __cache = {}
  __cacheExpiry = {}
  __dirtyCacheKeys = Object.create(null)

  Object.keys(COLS).forEach(function (name) {
    __tables[name] = [COLS[name].slice()]
  })

  var tableNames = requestedTables || Object.keys(COLS)
  var reads = tableNames.map(async function (tableName) {
    var rows = await __readAll(db, 'SELECT * FROM "' + tableName + '" ORDER BY rowid')
    rows.forEach(function (record) {
      __tables[tableName].push(COLS[tableName].map(function (column) {
        return record[column] === undefined || record[column] === null ? '' : record[column]
      }))
    })
  })
  reads.push(__readAll(db, 'SELECT cache_key, cache_value, expires_at FROM PawnAuth').then(function (cacheRows) {
    var now = Date.now()
    cacheRows.forEach(function (row) {
      if (Number(row.expires_at) > now) {
        __cache[row.cache_key] = row.cache_value
        __cacheExpiry[row.cache_key] = Number(row.expires_at)
      } else __dirtyCacheKeys[row.cache_key] = true
    })
  }))
  await Promise.all(reads)
}

async function __readAll(db, sql) {
  var results = []
  var select = sql.replace(/^SELECT\s+/i, 'SELECT rowid AS __cursor, ')
  var fromIndex = select.search(/\sFROM\s/i)
  var tableAndWhere = select.slice(fromIndex)
  var orderIndex = tableAndWhere.search(/\sORDER BY rowid\s*$/i)
  if (orderIndex >= 0) tableAndWhere = tableAndWhere.slice(0, orderIndex)
  var cursor = 0
  while (true) {
    var page = await db.prepare(select.slice(0, fromIndex) +
      tableAndWhere + ' WHERE rowid > ? ORDER BY rowid LIMIT 500').bind(cursor).all()
    var rows = page.results || []
    rows.forEach(function (row) { results.push(row) })
    if (rows.length < 500) return results
    cursor = Number(rows[rows.length - 1].__cursor)
  }
}

function __recordKey(columns, row) {
  return String(row[0] === undefined || row[0] === null ? '' : row[0])
}

async function __flushState() {
  var statements = []
  Object.keys(COLS).forEach(function (name) {
    var dirtyRows = __dirtyRows[name]
    if (!dirtyRows) return
    var columns = COLS[name]
    var keyColumn = name === 'Config' ? 'key' : (name === 'Operations' ? 'requestId' : 'id')
    Object.keys(dirtyRows).forEach(function (key) {
      var row = dirtyRows[key]
      if (!row) {
        statements.push(__db.prepare('DELETE FROM "' + name + '" WHERE "' + keyColumn + '" = ?').bind(key))
        return
      }
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
    })
  })

  var authTable = 'PawnAuth'
  Object.keys(__dirtyCacheKeys).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(__cache, key)) {
      statements.push(__db.prepare('DELETE FROM "' + authTable + '" WHERE cache_key = ?').bind(key))
    } else {
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

  if (payload.action === 'ping') {
    return __json({ ok: true, service: 'pawnshop', version: 1 }, 200, origin)
  }
  var tablesByAction = {
    setupStatus: ['Config'],
    login: ['Employees'],
    me: ['Employees'],
    logout: ['Employees'],
    'user.password': ['Employees'],
    'product.get': ['Employees', 'Products', 'Statements'],
    'report.range': ['Employees', 'Products', 'Statements', 'Accounting'],
    bootstrap: ['Employees', 'Products', 'Statements', 'Accounting', 'Creditors', 'CreditorMoves', 'Types', 'Due']
  }
  await __loadState(env.DB, tablesByAction[payload.action])
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
