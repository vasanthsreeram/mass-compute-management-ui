CREATE TABLE massed_vms (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product_name TEXT,
  image_name TEXT,
  price_cents_per_hour INTEGER NOT NULL DEFAULT 0,
  massed_created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  hours REAL NOT NULL DEFAULT 0,
  cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE INDEX idx_massed_vms_seen ON massed_vms(last_seen_at);
CREATE INDEX idx_massed_vms_ended ON massed_vms(ended_at);

CREATE TABLE massed_ticks (
  id TEXT PRIMARY KEY,
  taken_at TEXT NOT NULL,
  running INTEGER NOT NULL,
  burn_cents_per_hour INTEGER NOT NULL,
  watch_cents INTEGER NOT NULL
);

CREATE INDEX idx_massed_ticks_at ON massed_ticks(taken_at);
