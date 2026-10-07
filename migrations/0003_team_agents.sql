-- Email whitelist: only invited addresses may register.
CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  credit_cents INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  allowed_gpus TEXT NOT NULL DEFAULT '["*"]',
  invited_by TEXT,
  created_at TEXT NOT NULL
);

-- Pending sign-ups waiting for the emailed one-time code.
CREATE TABLE signup_otps (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Agent tokens now expire and are minted by the browser approval flow.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';

-- Device-style login: agent starts, human approves in the browser, agent polls.
CREATE TABLE device_codes (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  token_enc TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
