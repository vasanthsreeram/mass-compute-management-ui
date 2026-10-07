-- Where to send the browser after the Massed consent screen: the app ("app") or the standalone connect page ("connect").
ALTER TABLE massed_oauth_states ADD COLUMN return_to TEXT NOT NULL DEFAULT 'connect';
