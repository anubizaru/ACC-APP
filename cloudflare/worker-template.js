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

async function __selectRows(db, tableName, plan) {
  var sql = 'SELECT * FROM "' + tableName + '"'
  if (plan && plan.where) sql += ' WHERE ' + plan.where
  if (plan && plan.orderBy) sql += ' ORDER BY ' + plan.orderBy
  if (plan && plan.limit) sql += ' LIMIT ' + Number(plan.limit)
  var statement = db.prepare(sql)
  if (plan && plan.values && plan.values.length) {
    statement = statement.bind.apply(statement, plan.values)
  }
  var result = await statement.all()
  return result.results || []
}

function __appendRows(tableName, records) {
  records.forEach(function (record) {
    __tables[tableName].push(COLS[tableName].map(function (column) {
      return record[column] === undefined || record[column] === null ? '' : record[column]
    }))
  })
}

async function __loadState(db, tablePlans, cacheKeys, seededRows, seededCacheRows) {
  __db = db
  __tables = {}
  __dirtyRows = {}
  __cache = {}
  __cacheExpiry = {}
  __dirtyCacheKeys = Object.create(null)

  Object.keys(COLS).forEach(function (name) {
    __tables[name] = [COLS[name].slice()]
  })

  var plans = tablePlans || Object.keys(COLS).reduce(function (result, name) {
    result[name] = null
    return result
  }, {})
  var initialRows = seededRows || {}
  var tableNames = Object.keys(plans)
  Object.keys(initialRows).forEach(function (tableName) {
    if (tableNames.indexOf(tableName) < 0) tableNames.push(tableName)
  })
  var reads = tableNames.map(async function (tableName) {
    var rows = Object.prototype.hasOwnProperty.call(initialRows, tableName)
      ? initialRows[tableName]
      : plans[tableName]
        ? await __selectRows(db, tableName, plans[tableName])
        : await __readAll(db, 'SELECT * FROM "' + tableName + '" ORDER BY rowid')
    __appendRows(tableName, rows)
  })
  var cacheRows = (seededCacheRows || []).slice()
  var missingCacheKeys = (cacheKeys || []).filter(function (key) {
    return !cacheRows.some(function (row) { return row.cache_key === key })
  })
  var cacheRead = Promise.resolve([])
  if (missingCacheKeys.length) {
    var placeholders = missingCacheKeys.map(function () { return '?' }).join(', ')
    var cacheStatement = db.prepare(
      'SELECT cache_key, cache_value, expires_at FROM PawnAuth WHERE cache_key IN (' + placeholders + ')'
    )
    cacheStatement = cacheStatement.bind.apply(cacheStatement, missingCacheKeys)
    cacheRead = cacheStatement.all().then(function (result) { return result.results || [] })
  }
  await Promise.all(reads)
  cacheRows = cacheRows.concat(await cacheRead)
  var now = Date.now()
  cacheRows.forEach(function (row) {
    __cache[row.cache_key] = row.cache_value
    __cacheExpiry[row.cache_key] = Number(row.expires_at)
    if (Number(row.expires_at) <= now) __dirtyCacheKeys[row.cache_key] = true
  })
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
  var dataChanged = Object.keys(__dirtyRows).some(function (name) {
    return name !== 'Operations' && Object.keys(__dirtyRows[name] || {}).length > 0
  })
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

  if (dataChanged) {
    statements.push(__db.prepare(
      'INSERT INTO Config ("key", value) VALUES (?, ?) ' +
      'ON CONFLICT("key") DO UPDATE SET value = CAST(value AS INTEGER) + 1'
    ).bind('dataRevision', '1'))
  }

  for (var start = 0; start < statements.length; start += 100) {
    await __db.batch(statements.slice(start, start + 100))
  }
  return dataChanged
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

function __queryPlan(where, values, orderBy, limit) {
  return { where: where, values: values || [], orderBy: orderBy || '', limit: limit || 0 }
}

function __addRequestIdPlan(plans, payload) {
  if (!payload.requestId) payload.requestId = uuid_()
  plans.Operations = __queryPlan('requestId = ?', [String(payload.requestId)])
}

async function __loadRequestState(db, payload) {
  var action = payload.action
  var data = payload.data || {}
  var idempotentActions = [
    'product.create', 'product.update', 'product.delete', 'finance.op', 'statement.void',
    'accounting.add', 'accounting.void', 'accounting.delete', 'creditor.save',
    'creditorMove.add', 'type.delete', 'user.save'
  ]
  if (idempotentActions.indexOf(action) >= 0 && !payload.requestId) payload.requestId = uuid_()
  var plans = {}
  var seededRows = {}
  var seededCacheRows = []
  var cacheKeys = []
  var tokenCacheKey = ''
  var userId = ''

  if (action === 'login') {
    plans.Employees = __queryPlan('email = ?', [String(data.email || '').trim().toLowerCase()])
    cacheKeys.push('fail_' + String(data.email || '').trim().toLowerCase())
  } else if (payload.token) {
    tokenCacheKey = 'tk_' + await __tokenKey(payload.token)
    seededCacheRows = await __selectRows(db, 'PawnAuth', __queryPlan('cache_key = ?', [tokenCacheKey]))
    var session = seededCacheRows[0]
    if (session && Number(session.expires_at) > Date.now()) {
      userId = String(session.cache_value || '')
      if (userId) plans.Employees = __queryPlan('id = ?', [userId])
    }
  }

  if (action !== 'login' && action !== 'setupStatus' && !userId) {
    await __loadState(db, {}, cacheKeys, seededRows, seededCacheRows)
    return
  }

  if (action === 'bootstrap' && data.revision !== undefined) {
    var revisionRows = await __selectRows(db, 'Config', __queryPlan('"key" = ?', ['dataRevision']))
    var revision = revisionRows.length ? String(revisionRows[0].value) : '0'
    if (String(data.revision) === revision) {
      seededRows.Employees = await __selectRows(db, 'Employees', __queryPlan('id = ?', [userId]))
      await __loadState(db, { Employees: __queryPlan('id = ?', [userId]) }, cacheKeys, seededRows, seededCacheRows)
      payload.__unchangedRevision = revision
      return
    }
  }

  if (action === 'setupStatus') {
    plans.Config = __queryPlan('"key" = ?', ['setupDone'])
  } else if (action === 'bootstrap') {
    ;['Employees', 'Products', 'Statements', 'Accounting', 'Creditors', 'CreditorMoves', 'Types', 'Due'].forEach(function (name) {
      plans[name] = null
    })
    plans.Config = __queryPlan('"key" = ?', ['dataRevision'])
  } else if (action === 'product.create') {
    var requestedNo = data.productNo
    plans.Products = requestedNo === undefined || requestedNo === null || requestedNo === ''
      ? __queryPlan('', [], 'productNo DESC', 1)
      : __queryPlan('productNo = ?', [requestedNo])
    plans.Due = null
    __addRequestIdPlan(plans, payload)
  } else if (action === 'product.update') {
    plans.Products = __queryPlan('id = ? OR productNo = ?', [
      String(data.id || ''), data.productNo === undefined ? null : data.productNo
    ])
    plans.Statements = __queryPlan('productId = ?', [String(data.id || '')])
    __addRequestIdPlan(plans, payload)
  } else if (action === 'product.get' || action === 'product.delete') {
    plans.Products = __queryPlan('id = ?', [String(data.id || '')])
    plans.Statements = __queryPlan('productId = ?', [String(data.id || '')])
    if (action === 'product.delete') __addRequestIdPlan(plans, payload)
  } else if (action === 'finance.op') {
    plans.Products = __queryPlan('id = ?', [String(data.id || '')])
    __addRequestIdPlan(plans, payload)
  } else if (action === 'statement.void') {
    __addRequestIdPlan(plans, payload)
    var targetStatements = await __selectRows(db, 'Statements', __queryPlan('id = ?', [String(data.id || '')]))
    seededRows.Statements = targetStatements
    var targetStatement = targetStatements[0]
    if (targetStatement) {
      plans.Operations = __queryPlan('requestId = ? OR requestId = ?', [
        String(payload.requestId || ''), String(targetStatement.requestId || '')
      ])
      plans.Products = __queryPlan('id = ?', [String(targetStatement.productId || '')])
    }
  } else if (action === 'accounting.add') {
    __addRequestIdPlan(plans, payload)
  } else if (action === 'accounting.void' || action === 'accounting.delete') {
    plans.Accounting = __queryPlan(
      'id = ? OR voidOf = ?', [String(data.id || ''), String(data.id || '')]
    )
    __addRequestIdPlan(plans, payload)
  } else if (action === 'creditor.save') {
    if (data.id) plans.Creditors = __queryPlan('id = ?', [String(data.id)])
    __addRequestIdPlan(plans, payload)
  } else if (action === 'creditorMove.add') {
    plans.Creditors = __queryPlan('id = ?', [String(data.creditorId || '')])
    if (Number(data.refund) > 0) {
      plans.CreditorMoves = __queryPlan('creditorId = ?', [String(data.creditorId || '')])
    }
    __addRequestIdPlan(plans, payload)
  } else if (action === 'report.range') {
    var start = String(data.start || '')
    var end = String(data.end || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      seededRows.Statements = []
      seededRows.Products = []
    } else {
      var reportStatements = await __selectRows(db, 'Statements', __queryPlan('date >= ? AND date <= ?', [start, end]))
      seededRows.Statements = reportStatements
      plans.Accounting = __queryPlan('date >= ? AND date <= ?', [start, end])
      var productIds = []
      reportStatements.forEach(function (statement) {
        if (statement.productId && productIds.indexOf(String(statement.productId)) < 0) productIds.push(String(statement.productId))
      })
      var productRows = []
      for (var offset = 0; offset < productIds.length; offset += 500) {
        var ids = productIds.slice(offset, offset + 500)
        if (!ids.length) continue
        productRows = productRows.concat(await __selectRows(db, 'Products', __queryPlan(
          'id IN (' + ids.map(function () { return '?' }).join(', ') + ')', ids
        )))
      }
      seededRows.Products = productRows
    }
  } else if (action === 'type.save') {
    if (data.id) plans.Types = __queryPlan('id = ?', [String(data.id)])
  } else if (action === 'type.delete') {
    plans.Types = null
    plans.Products = __queryPlan('typeId = ?', [String(data.id || '')], 'rowid', 1)
    __addRequestIdPlan(plans, payload)
  } else if (action === 'due.save') {
    var dueId = data.id || 'due-' + Number(data.due)
    plans.Due = __queryPlan('id = ?', [String(dueId)])
  } else if (action === 'user.save') {
    var email = String(data.email || '').trim().toLowerCase()
    plans.Employees = data.id
      ? __queryPlan('id = ? OR id = ?', [String(data.id), userId])
      : __queryPlan('id = ? OR email = ?', [userId, email])
    __addRequestIdPlan(plans, payload)
  } else if (action === 'user.password') {
    var targetId = data.id ? String(data.id) : userId
    plans.Employees = __queryPlan('id = ? OR id = ?', [userId, targetId])
  }

  if (action === 'login') cacheKeys.push('fail_' + String(data.email || '').trim().toLowerCase())
  await __loadState(db, plans, cacheKeys, seededRows, seededCacheRows)
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
  if (payload.action === 'ping') {
    return __json({ ok: true, service: 'pawnshop', version: 1 }, 200, origin)
  }
  await __loadRequestState(env.DB, payload)
  if (payload.__unchangedRevision !== undefined) {
    var auth = await __route({ action: 'me', token: payload.token })
    await __flushState()
    if (!auth || auth.ok !== true) return __json(auth, 200, origin)
    return __json({ ok: true, unchanged: true, revision: payload.__unchangedRevision }, 200, origin)
  }
  var response = await __route(payload)
  var dataChanged = await __flushState()
  if (payload.action === 'bootstrap') {
    response.revision = String(getConfig_('dataRevision') || '0')
  } else if (dataChanged) {
    var currentRevision = await env.DB.prepare('SELECT value FROM Config WHERE "key" = ?').bind('dataRevision').first()
    response.revision = currentRevision ? String(currentRevision.value) : '0'
    var clientRevision = payload.data && payload.data.revision
    if (clientRevision !== undefined) {
      response.refreshRequired = Number(response.revision) !== Number(clientRevision) + 1
    }
  }
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
