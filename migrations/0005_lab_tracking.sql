-- Lab-wide Massed connection, full tracking, money-bug fixes, SSH keys, onboarding.

-- A lost connection keeps its row (so we can show "lost since ..." and email admins once).
ALTER TABLE massed_connections ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE massed_connections ADD COLUMN lost_at TEXT;
ALTER TABLE massed_connections ADD COLUMN lost_notified_at TEXT;

-- Key/value settings for the lab (designated admin connection, app origin, ...).
CREATE TABLE lab_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- connected, refreshed, refresh_failed, rejected, lost, disconnected, designated
CREATE TABLE connection_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_connection_events_at ON connection_events(created_at);

-- Who launched what, and money-exact metering state.
ALTER TABLE instances ADD COLUMN api_key_id TEXT;
ALTER TABLE instances ADD COLUMN ssh_fingerprints TEXT;
ALTER TABLE instances ADD COLUMN carry_cents REAL NOT NULL DEFAULT 0;
ALTER TABLE instances ADD COLUMN billed_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE instances ADD COLUMN end_reason TEXT;
ALTER TABLE usage_events ADD COLUMN api_key_id TEXT;
ALTER TABLE usage_events ADD COLUMN product_name TEXT;
CREATE INDEX idx_instances_uuid ON instances(mc_uuid);

-- Every launch / restart / terminate / failure with the actor.
-- kind: launch, launch_failed, restart, restart_failed, terminate, terminate_failed,
--       budget_kill, budget_kill_failed, gone_upstream, stale_launch
CREATE TABLE vm_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  instance_id TEXT,
  mc_uuid TEXT,
  user_id TEXT,
  api_key_id TEXT,
  actor TEXT NOT NULL DEFAULT 'user',
  product_name TEXT,
  price_cents_per_hour INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_vm_events_at ON vm_events(created_at);
CREATE INDEX idx_vm_events_user ON vm_events(user_id);

-- Watcher: join Massed VMs to our users. attribution: app | name_tag | manual | unattributed
ALTER TABLE massed_vms ADD COLUMN instance_id TEXT;
ALTER TABLE massed_vms ADD COLUMN user_id TEXT;
ALTER TABLE massed_vms ADD COLUMN api_key_id TEXT;
ALTER TABLE massed_vms ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unattributed';
ALTER TABLE massed_vms ADD COLUMN cents_exact REAL NOT NULL DEFAULT 0;
UPDATE massed_vms SET cents_exact = cents;
CREATE INDEX idx_massed_vms_user ON massed_vms(user_id);

ALTER TABLE massed_ticks ADD COLUMN attributed_burn_cents_per_hour INTEGER NOT NULL DEFAULT 0;
ALTER TABLE massed_ticks ADD COLUMN unattributed_burn_cents_per_hour INTEGER NOT NULL DEFAULT 0;
ALTER TABLE massed_ticks ADD COLUMN unattributed_running INTEGER NOT NULL DEFAULT 0;

-- Recharge amount/threshold changes, stored only when they differ from the last snapshot.
CREATE TABLE billing_snapshots (
  id TEXT PRIMARY KEY,
  billing_method TEXT,
  recharge_amount_cents INTEGER NOT NULL DEFAULT 0,
  recharge_threshold_cents INTEGER NOT NULL DEFAULT 0,
  taken_at TEXT NOT NULL
);
CREATE INDEX idx_billing_snapshots_at ON billing_snapshots(taken_at);

-- Manual balance readings from an admin, for calibrating our estimate.
CREATE TABLE balance_entries (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  topup_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  watch_cents_total INTEGER NOT NULL DEFAULT 0,
  taken_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_balance_entries_at ON balance_entries(taken_at);

-- Public SSH keys members save and we pass at launch (MCP redacts VM passwords).
CREATE TABLE user_ssh_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX idx_user_ssh_keys_user ON user_ssh_keys(user_id);

-- First-run tutorial state. Steps are derived from data; only dismissal is stored.
CREATE TABLE onboarding_progress (
  user_id TEXT NOT NULL,
  step TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (user_id, step)
);
