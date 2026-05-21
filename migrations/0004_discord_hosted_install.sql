CREATE TABLE IF NOT EXISTS discord_install_states (
  state TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  return_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_install_states_expires_at ON discord_install_states(expires_at);

ALTER TABLE discord_configs ADD COLUMN guild_name TEXT;
ALTER TABLE discord_configs ADD COLUMN installed_at TEXT;
ALTER TABLE discord_configs ADD COLUMN setup_template_id TEXT;
ALTER TABLE discord_configs ADD COLUMN setup_applied_at TEXT;
ALTER TABLE discord_configs ADD COLUMN starter_messages_applied_at TEXT;
ALTER TABLE discord_configs ADD COLUMN stream_announcement_channel_id TEXT;
ALTER TABLE discord_configs ADD COLUMN general_announcement_channel_id TEXT;
ALTER TABLE discord_configs ADD COLUMN suggestion_channel_id TEXT;
ALTER TABLE discord_configs ADD COLUMN stream_alerts_role_id TEXT;
ALTER TABLE discord_configs ADD COLUMN created_channel_ids_json TEXT DEFAULT '{}';
ALTER TABLE discord_configs ADD COLUMN created_role_ids_json TEXT DEFAULT '{}';
ALTER TABLE discord_configs ADD COLUMN created_message_ids_json TEXT DEFAULT '{}';
