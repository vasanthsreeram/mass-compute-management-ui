-- "Connect Massed Compute" (OAuth 2.1 + PKCE against vm.massedcompute.com).
-- One dynamically registered public client per redirect URI.
CREATE TABLE massed_oauth_apps (
  redirect_uri TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- In-flight authorizations. state is stored hashed; the PKCE verifier is encrypted.
CREATE TABLE massed_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- One connected Massed account per proxy user. Tokens are AES-GCM encrypted with DATA_KEY.
CREATE TABLE massed_connections (
  user_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  access_enc TEXT NOT NULL,
  refresh_enc TEXT,
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_used_at TEXT,
  last_error TEXT
);
