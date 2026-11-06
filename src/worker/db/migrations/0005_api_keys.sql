-- Inbox API: per-user API keys and idempotent sends.

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,           -- the first characters of the key, to recognize it in the UI
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the key; the key itself is never stored
  scopes TEXT NOT NULL,           -- JSON array of 'read', 'send', 'modify'
  mailbox_ids TEXT,               -- JSON array the key is limited to, or NULL for all of the user's mailboxes
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_used_ip TEXT
);
CREATE INDEX api_keys_user ON api_keys (user_id);

-- A retried POST /api/v1/messages with the same Idempotency-Key returns the first message
-- instead of sending again. Kept for a day.
CREATE TABLE api_idempotency (
  key_id INTEGER NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);

-- New messages in order of arrival, for clients polling GET /api/v1/messages?since=.
CREATE INDEX messages_created ON messages (mailbox_id, created_at, id);
