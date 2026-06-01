export const serviceName = "vaexcore relay";
export const serviceVersion = "0.1.0";
export const maxJsonBytes = 64 * 1024;
export const maxOutboundRetryAttempts = 3;
export const outboundRetryBatchLimit = 25;
export const defaultRetryBackoffMs = 60_000;
export const hostedDiscordSetupMutationLimit = 15;

export type RelayEnv = Env & {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_EVENTSUB_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  RELAY_ADMIN_TOKEN: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_OPERATOR_ROLE_ID?: string;
  DISCORD_API_BASE_URL?: string;
};

export type DiscordConfigRow = {
  installation_id: string;
  application_id: string | null;
  guild_id: string | null;
  guild_name?: string | null;
  operator_role_id: string | null;
  interaction_url: string;
  installed_at?: string | null;
  setup_template_id?: string | null;
  setup_applied_at?: string | null;
  starter_messages_applied_at?: string | null;
  stream_announcement_channel_id?: string | null;
  general_announcement_channel_id?: string | null;
  suggestion_channel_id?: string | null;
  stream_alerts_role_id?: string | null;
  created_channel_ids_json?: string | null;
  created_role_ids_json?: string | null;
  created_message_ids_json?: string | null;
  updated_at: string;
};
