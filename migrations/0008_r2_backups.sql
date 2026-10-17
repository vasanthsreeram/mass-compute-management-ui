-- R2 backup loop: restic repos per member behind the Worker, VM-bound credentials, quotas, drain-before-kill.

-- budget_cents = credit at the last grant/top-up (invite, or an admin raising credit). The drain starts at 10% of it.
ALTER TABLE users ADD COLUMN budget_cents INTEGER NOT NULL DEFAULT 0;
UPDATE users SET budget_cents = credit_cents;
-- NULL = use lab_settings.backup_default_quota_bytes (default 5 GB).
ALTER TABLE users ADD COLUMN backup_quota_bytes INTEGER;

-- backup_state: none | ok | draining | final_requested | done
ALTER TABLE instances ADD COLUMN backup_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE instances ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE instances ADD COLUMN last_backup_at TEXT;
ALTER TABLE instances ADD COLUMN drain_started_at TEXT;
-- budget | user: why the drain started (decides how the VM ends once the final snapshot lands)
ALTER TABLE instances ADD COLUMN drain_reason TEXT;
ALTER TABLE instances ADD COLUMN backup_requested INTEGER NOT NULL DEFAULT 0;

-- One snapshot report per backup (agent -> POST /api/agent/backup).
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT,
  snapshot_id TEXT NOT NULL,
  tag TEXT,
  bytes_added INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backups_user ON backups(user_id, created_at);
CREATE INDEX idx_backups_instance ON backups(instance_id, created_at);

-- Single-use, 10 minute token injected in the launch command. Only the hash is stored.
CREATE TABLE backup_enrollments (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backup_enrollments_instance ON backup_enrollments(instance_id);

-- What a VM holds after enrolling: scope is that user's restic prefix + that instance. Only the hash is stored.
CREATE TABLE vm_credentials (
  cred_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_vm_credentials_instance ON vm_credentials(instance_id);

-- Per-object sizes (exact accounting across overwrites/deletes) and the running total per member.
CREATE TABLE backup_objects (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_backup_objects_user ON backup_objects(user_id);
CREATE TABLE backup_usage (
  user_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
