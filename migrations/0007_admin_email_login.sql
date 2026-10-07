-- Passwordless admin sign-in (emailed one-time code) shares the signup_otps table, so each code records
-- what it is for. A member-signup code can never sign someone in as an admin, or the reverse.
ALTER TABLE signup_otps ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signup';

-- Fixed-window rate limits (code requests per email and per IP).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
