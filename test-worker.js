const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = __dirname
const source = [
  fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudflare/worker-template.js'), 'utf8')
].join('\n')
const workerSource = source.slice(0, source.lastIndexOf('\nexport default {')) +
  '\nreturn { handle: __handle, tokenKey: __tokenKey }'
const worker = new Function(
  'crypto', 'TextEncoder', 'Response', 'URL',
  workerSource
)(crypto.webcrypto, TextEncoder, Response, URL)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

class MockD1 {
  constructor(tables) {
    this.tables = tables
    this.reads = []
    if (!this.tables.Config) this.tables.Config = []
  }

  prepare(sql) {
    const self = this
    let values = []
    return {
      bind(...args) { values = args; return this },
      async all() {
        const tableMatch = sql.match(/\bFROM\s+"?([A-Za-z_]+)"?/i)
        if (!tableMatch) throw new Error('Unsupported query: ' + sql)
        const table = tableMatch[1]
        let rows = (self.tables[table] || []).map((row, index) => Object.assign(
          { __cursor: index + 1, __rowid: index + 1 }, row
        ))
        const whereMatch = sql.match(/\bWHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i)
        if (whereMatch) rows = rows.filter(row => matches(row, whereMatch[1], values))
        const orderMatch = sql.match(/\bORDER BY\s+([A-Za-z_]+)(?:\s+(ASC|DESC))?/i)
        if (orderMatch) {
          const field = orderMatch[1]
          const descending = orderMatch[2] === 'DESC'
          rows.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (descending ? -1 : 1))
        }
        const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i)
        if (limitMatch) rows = rows.slice(0, Number(limitMatch[1]))
        self.reads.push({ sql, table, rowCount: rows.length })
        return { results: rows }
      },
      async first() {
        const result = await this.all()
        return result.results[0] || null
      },
      async run() {
        if (/INSERT INTO Config/i.test(sql) && values[0] === 'dataRevision') {
          const current = self.tables.Config.find(row => row.key === 'dataRevision')
          if (current) current.value = String(Number(current.value) + 1)
          else self.tables.Config.push({ key: 'dataRevision', value: '1' })
        }
        return { success: true }
      }
    }
  }

  async batch(statements) {
    await Promise.all(statements.map(statement => statement.run()))
    return []
  }
}

function matches(row, expression, values) {
  let valueIndex = 0
  return expression.split(/\s+OR\s+/i).some(part => {
    const alternatives = part.split(/\s+AND\s+/i)
    return alternatives.every(condition => {
      const inMatch = condition.match(/"?([A-Za-z_]+)"?\s+IN\s*\(([^)]*)\)/i)
      if (inMatch) {
        const count = inMatch[2].split(',').length
        const candidates = values.slice(valueIndex, valueIndex + count)
        valueIndex += count
        return candidates.includes(row[inMatch[1]])
      }
      const comparison = condition.match(/"?([A-Za-z_]+)"?\s*(=|>=|<=|>)\s*\?/i)
      if (!comparison) throw new Error('Unsupported filter: ' + condition)
      const expected = values[valueIndex++]
      const actual = comparison[1].toLowerCase() === 'rowid' ? row.__rowid : row[comparison[1]]
      if (comparison[2] === '>=') return String(actual) >= String(expected)
      if (comparison[2] === '<=') return String(actual) <= String(expected)
      if (comparison[2] === '>') return Number(actual) > Number(expected)
      return actual !== undefined && String(actual) === String(expected)
    })
  })
}

function post(payload, db) {
  return worker.handle(new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }), { DB: db })
}

async function main() {
  const pingDb = new MockD1({})
  const ping = await (await post({ action: 'ping' }, pingDb)).json()
  assert(ping.ok === true && pingDb.reads.length === 0, 'ping should not read D1')

  const configDb = new MockD1({ Config: [{ key: 'setupDone', value: '1' }] })
  const setup = await (await post({ action: 'setupStatus' }, configDb)).json()
  assert(setup.ok === true && setup.setupDone === true, 'setup status should read the setup flag')
  assert(configDb.reads.length === 1 && configDb.reads[0].table === 'Config', 'setup status should read only Config')

  const invalidSessionDb = new MockD1({})
  const unauthorized = await (await post({ action: 'bootstrap', token: 'missing' }, invalidSessionDb)).json()
  assert(unauthorized.error === 'auth', 'invalid session should be rejected')
  assert(invalidSessionDb.reads.length === 1 && invalidSessionDb.reads[0].table === 'PawnAuth', 'invalid session must not load business tables')

  const token = 'session-token'
  const tokenKey = 'tk_' + await worker.tokenKey(token)
  const expiresAt = Date.now() + 60 * 60 * 1000
  const db = new MockD1({
    PawnAuth: [{ cache_key: tokenKey, cache_value: 'user-1', expires_at: expiresAt }],
    Employees: [{ id: 'user-1', name: 'Owner', email: 'owner@example.test', passwordHash: '', salt: '', role: 'admin', avatar: '', active: 1, createdAt: '2026-01-01' }],
    Products: [
      { id: 'product-1', productNo: 1, customerName: 'Customer', customerIdCard: '', typeId: 'gold', detail: 'Ring', price: 1000, interest: 100, due: 30, startDate: '2026-01-01', endDate: '2026-02-01', status: 1, closeStatus: '', desc: '', createdBy: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'product-2', productNo: 2, customerName: 'Other', customerIdCard: '', typeId: 'gold', detail: 'Watch', price: 2000, interest: 200, due: 30, startDate: '2026-01-01', endDate: '2026-02-01', status: 1, closeStatus: '', desc: '', createdBy: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    ],
    Statements: [
      { id: 'statement-1', productId: 'product-1', type: 'new', date: '2026-01-01', income: 0, pay: 1000, profit: 0, priceAfter: 1000, interestAfter: 100, dueAfter: 30, endDateAfter: '2026-02-01', closeStatusAfter: '', note: '', requestId: 'request-1', createdBy: 'user-1', createdAt: '2026-01-01', void: '', voidOf: '' },
      { id: 'statement-2', productId: 'product-2', type: 'new', date: '2026-01-01', income: 0, pay: 2000, profit: 0, priceAfter: 2000, interestAfter: 200, dueAfter: 30, endDateAfter: '2026-02-01', closeStatusAfter: '', note: '', requestId: 'request-2', createdBy: 'user-1', createdAt: '2026-01-01', void: '', voidOf: '' }
    ]
  })
  const detail = await (await post({ action: 'product.get', token, data: { id: 'product-1' } }, db)).json()
  assert(detail.ok === true && detail.product.id === 'product-1', 'product detail should return the requested product')
  assert(detail.statements.length === 1 && detail.statements[0].id === 'statement-1', 'product detail should return only its statements')
  const readsByTable = Object.fromEntries(db.reads.map(read => [read.table, read]))
  assert(readsByTable.Employees.sql.includes('WHERE id = ?'), 'authentication should load one employee')
  assert(readsByTable.Products.sql.includes('WHERE id = ?'), 'product detail should load one product')
  assert(readsByTable.Statements.sql.includes('WHERE productId = ?'), 'product detail should filter statements by product')
  assert(!db.reads.some(read => read.table === 'Operations'), 'read-only product detail should not read operations')

  const reportDb = new MockD1({
    PawnAuth: [{ cache_key: tokenKey, cache_value: 'user-1', expires_at: expiresAt }],
    Employees: [{ id: 'user-1', name: 'Owner', email: 'owner@example.test', passwordHash: '', salt: '', role: 'admin', avatar: '', active: 1, createdAt: '2026-01-01' }],
    Products: [
      { id: 'product-1', productNo: 1, customerName: 'Customer', detail: 'Ring' },
      { id: 'product-2', productNo: 2, customerName: 'Other', detail: 'Watch' }
    ],
    Statements: [
      { id: 'statement-in-range', productId: 'product-1', type: 'interest', date: '2026-02-01', income: 0, pay: 0, profit: 100, void: '', voidOf: '', createdBy: 'user-1' },
      { id: 'statement-out-of-range', productId: 'product-2', type: 'interest', date: '2026-01-01', income: 0, pay: 0, profit: 200, void: '', voidOf: '', createdBy: 'user-1' }
    ],
    Accounting: [
      { id: 'accounting-in-range', date: '2026-02-02', title: 'Expense', income: 0, pay: 50, void: '' },
      { id: 'accounting-out-of-range', date: '2026-01-01', title: 'Old expense', income: 0, pay: 25, void: '' }
    ]
  })
  const report = await (await post({
    action: 'report.range', token, data: { start: '2026-02-01', end: '2026-02-28' }
  }, reportDb)).json()
  assert(report.ok === true && report.statements.length === 1, 'report should return only statements in range')
  assert(report.statements[0].productNo === 1, 'report should load product metadata only for matching statements')
  assert(report.accounting.length === 1 && report.accounting[0].id === 'accounting-in-range', 'report should return accounting rows in range')
  assert(report.summary.profit === 100 && report.summary.accOut === 50, 'report totals should use the filtered rows')
  assert(reportDb.reads.filter(read => read.table === 'Statements').every(read => read.sql.includes('date >= ? AND date <= ?')), 'report should filter statement rows in D1')
  assert(reportDb.reads.filter(read => read.table === 'Accounting').every(read => read.sql.includes('date >= ? AND date <= ?')), 'report should filter accounting rows in D1')
  assert(reportDb.reads.some(read => read.table === 'Products' && read.sql.includes('id IN (?)')), 'report should fetch only referenced products')

  const bootstrapDb = new MockD1({
    PawnAuth: [{ cache_key: tokenKey, cache_value: 'user-1', expires_at: expiresAt }],
    Employees: [{ id: 'user-1', name: 'Owner', email: 'owner@example.test', passwordHash: '', salt: '', role: 'admin', avatar: '', active: 1, createdAt: '2026-01-01' }],
    Config: [{ key: 'dataRevision', value: '7' }]
  })
  const bootstrap = await (await post({ action: 'bootstrap', token }, bootstrapDb)).json()
  assert(bootstrap.ok === true && bootstrap.revision === '7', 'initial bootstrap should include the data revision')
  const readsBeforeUnchanged = bootstrapDb.reads.length
  const unchanged = await (await post({ action: 'bootstrap', token, data: { revision: '7' } }, bootstrapDb)).json()
  assert(unchanged.ok === true && unchanged.unchanged === true, 'unchanged bootstrap should return a lightweight response')
  const unchangedReads = bootstrapDb.reads.slice(readsBeforeUnchanged)
  assert(unchangedReads.every(read => ['PawnAuth', 'Config', 'Employees'].includes(read.table)), 'unchanged bootstrap should not read business tables')

  const mutationDb = new MockD1({
    PawnAuth: [{ cache_key: tokenKey, cache_value: 'user-1', expires_at: expiresAt }],
    Employees: [{ id: 'user-1', name: 'Owner', email: 'owner@example.test', passwordHash: '', salt: '', role: 'admin', avatar: '', active: 1, createdAt: '2026-01-01' }],
    Products: [{ id: 'product-1', productNo: 1, customerName: 'Customer', customerIdCard: '', typeId: 'gold', detail: 'Ring', price: 1000, interest: 100, due: 30, startDate: '2026-01-01', endDate: '2026-02-01', status: 1, closeStatus: '', desc: '', createdBy: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
  })
  const mutation = await (await post({
    action: 'finance.op', token, requestId: 'finance-1',
    data: { id: 'product-1', op: 'interest', amount: 100, date: '2026-02-01', revision: '0' }
  }, mutationDb)).json()
  assert(mutation.ok === true && mutation.revision === '1', 'successful mutations should return the incremented revision')
  assert(mutation.refreshRequired === false, 'a mutation based on the current revision should keep local data')
  assert(mutationDb.reads.some(read => read.table === 'Operations' && read.sql.includes('WHERE requestId = ?')), 'mutations should load only the matching idempotency record')
  assert(mutationDb.reads.every(read => read.table !== 'Statements'), 'finance mutation should not scan statement history')

  const staleDb = new MockD1({
    PawnAuth: [{ cache_key: tokenKey, cache_value: 'user-1', expires_at: expiresAt }],
    Employees: [{ id: 'user-1', name: 'Owner', email: 'owner@example.test', passwordHash: '', salt: '', role: 'admin', avatar: '', active: 1, createdAt: '2026-01-01' }],
    Products: [{ id: 'product-1', productNo: 1, customerName: 'Customer', customerIdCard: '', typeId: 'gold', detail: 'Ring', price: 1000, interest: 100, due: 30, startDate: '2026-01-01', endDate: '2026-02-01', status: 1, closeStatus: '', desc: '', createdBy: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
    Config: [{ key: 'dataRevision', value: '5' }]
  })
  const staleMutation = await (await post({
    action: 'finance.op', token, requestId: 'finance-2',
    data: { id: 'product-1', op: 'interest', amount: 100, date: '2026-02-01', revision: '2' }
  }, staleDb)).json()
  assert(staleMutation.revision === '6' && staleMutation.refreshRequired === true, 'concurrent changes should force a full bootstrap refresh')
  console.log('Worker D1 read tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
