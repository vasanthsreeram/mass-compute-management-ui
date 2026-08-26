CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  credit_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  allowed_gpus TEXT NOT NULL DEFAULT '[]',
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  mc_uuid TEXT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  region_name TEXT NOT NULL DEFAULT 'any',
  price_cents_per_hour INTEGER NOT NULL,
  status TEXT NOT NULL,
  ip TEXT,
  username TEXT,
  password_enc TEXT,
  image_id INTEGER,
  launched_at TEXT NOT NULL,
  terminated_at TEXT,
  last_metered_at TEXT NOT NULL
);

CREATE INDEX idx_instances_user ON instances(user_id);
CREATE INDEX idx_instances_status ON instances(status);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  cents INTEGER NOT NULL,
  hours REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_usage_user ON usage_events(user_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
