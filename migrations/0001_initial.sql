CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  console_token_hash TEXT NOT NULL,
  bot_user_id TEXT,
  bot_login TEXT,
  broadcaster_user_id TEXT,
  broadcaster_login TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('bot', 'broadcaster')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('bot', 'broadcaster')),
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, grant_kind)
);

CREATE TABLE IF NOT EXISTS eventsub_subscriptions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  twitch_subscription_id TEXT,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  twitch_message_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_chat_sends (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  broadcaster_user_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'retry', 'failed')),
  twitch_message_id TEXT,
  failure_category TEXT,
  reason TEXT,
  retry_after_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_events_installation_delivered ON chat_events(installation_id, delivered_at, received_at);
CREATE INDEX IF NOT EXISTS idx_outbound_chat_sends_installation_created ON outbound_chat_sends(installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);

