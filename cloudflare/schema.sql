CREATE TABLE IF NOT EXISTS Employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Products (
  id TEXT PRIMARY KEY,
  productNo INTEGER NOT NULL,
  customerName TEXT NOT NULL,
  customerIdCard TEXT NOT NULL DEFAULT '',
  typeId TEXT NOT NULL,
  detail TEXT NOT NULL,
  price INTEGER NOT NULL,
  interest INTEGER NOT NULL,
  due INTEGER NOT NULL,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  closeStatus TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Statements (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  income INTEGER NOT NULL DEFAULT 0,
  pay INTEGER NOT NULL DEFAULT 0,
  profit INTEGER NOT NULL DEFAULT 0,
  priceAfter INTEGER NOT NULL DEFAULT 0,
  interestAfter INTEGER NOT NULL DEFAULT 0,
  dueAfter INTEGER NOT NULL DEFAULT 0,
  endDateAfter TEXT NOT NULL DEFAULT '',
  closeStatusAfter TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  requestId TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  void TEXT NOT NULL DEFAULT '',
  voidOf TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Accounting (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  income INTEGER NOT NULL DEFAULT 0,
  pay INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  requestId TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  void TEXT NOT NULL DEFAULT '',
  voidOf TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Creditors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS CreditorMoves (
  id TEXT PRIMARY KEY,
  creditorId TEXT NOT NULL,
  date TEXT NOT NULL,
  borrow INTEGER NOT NULL DEFAULT 0,
  refund INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  requestId TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Due (
  id TEXT PRIMARY KEY,
  due INTEGER NOT NULL,
  unit TEXT NOT NULL,
  title TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Operations (
  requestId TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  entityId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  resultJson TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Config (
  "key" TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS PawnAuth (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_Employees_email ON Employees(email);
CREATE INDEX IF NOT EXISTS idx_Products_productNo ON Products(productNo);
CREATE INDEX IF NOT EXISTS idx_Statements_productId ON Statements(productId);
CREATE INDEX IF NOT EXISTS idx_Statements_date ON Statements(date);
CREATE INDEX IF NOT EXISTS idx_Accounting_date ON Accounting(date);
CREATE INDEX IF NOT EXISTS idx_CreditorMoves_creditorId ON CreditorMoves(creditorId);
