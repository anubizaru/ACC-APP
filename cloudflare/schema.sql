CREATE TABLE IF NOT EXISTS PawnAuth (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
