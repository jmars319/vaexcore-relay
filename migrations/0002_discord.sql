CREATE TABLE IF NOT EXISTS discord_configs (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE REFERENCES installations(id) ON DELETE CASCADE,
  application_id TEXT,
  guild_id TEXT,
  operator_role_id TEXT,
  interaction_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_interactions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  discord_interaction_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'processed', 'failed', 'denied')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  processed_at TEXT,
  UNIQUE (installation_id, discord_interaction_id)
);

CREATE TABLE IF NOT EXISTS discord_suggestions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  discord_interaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  suggestion_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'reviewed', 'accepted', 'rejected', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, discord_interaction_id)
);

CREATE TABLE IF NOT EXISTS discord_command_registrations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  guild_id TEXT,
  commands_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered', 'failed')),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_configs_guild ON discord_configs(guild_id);
CREATE INDEX IF NOT EXISTS idx_discord_interactions_installation_status ON discord_interactions(installation_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_suggestions_installation_status ON discord_suggestions(installation_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_command_registrations_installation_created ON discord_command_registrations(installation_id, created_at);
