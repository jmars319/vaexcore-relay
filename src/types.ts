export const requiredBotScopes = [
  "user:bot",
  "user:read:chat",
  "user:write:chat",
] as const;

export const requiredBroadcasterScopes = ["channel:bot"] as const;

export type OAuthGrantKind = "bot" | "broadcaster";

export type InstallationRow = {
  id: string;
  name: string;
  console_token_hash: string;
  bot_user_id: string | null;
  bot_login: string | null;
  broadcaster_user_id: string | null;
  broadcaster_login: string | null;
  created_at: string;
  updated_at: string;
};

export type OAuthGrantRow = {
  installation_id: string;
  grant_kind: OAuthGrantKind;
  user_id: string;
  login: string;
  scopes_json: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string;
  updated_at: string;
};

export type TwitchTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string[];
  token_type: string;
};

export type TwitchTokenValidation = {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
};

export type TwitchEventSubEnvelope = {
  metadata?: {
    message_id?: string;
    message_type?: string;
    message_timestamp?: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload?: {
    challenge?: string;
    subscription?: {
      id?: string;
      type?: string;
      version?: string;
      status?: string;
      condition?: Record<string, unknown>;
    };
    event?: {
      broadcaster_user_id?: string;
      chatter_user_id?: string;
      chatter_user_login?: string;
      chatter_user_name?: string;
      message_id?: string;
      message?: { text?: string };
      badges?: Array<{ set_id?: string }>;
    };
  };
};

export type RelayChatEvent = {
  id: string;
  text: string;
  userId: string;
  userLogin: string;
  userDisplayName: string;
  broadcasterUserId: string;
  badges: string[];
  isBroadcaster: boolean;
  isMod: boolean;
  isVip: boolean;
  isSubscriber: boolean;
  source: "relay-eventsub";
  receivedAt: string;
};

export type RelayReadiness = {
  ready: boolean;
  mode: "relay-chatbot";
  checks: Array<{ key: string; ok: boolean; detail: string }>;
};

export type DiscordSuggestionStatus =
  | "new"
  | "reviewed"
  | "accepted"
  | "rejected"
  | "archived";

export type DiscordInteractionRow = {
  id: string;
  installation_id: string;
  discord_interaction_id: string;
  command_name: string;
  payload_json: string;
  status: "queued" | "delivered" | "processed" | "failed" | "denied";
  created_at: string;
  delivered_at: string | null;
  processed_at: string | null;
};

export type DiscordSuggestionRow = {
  id: string;
  installation_id: string;
  discord_interaction_id: string;
  user_id: string;
  username: string;
  suggestion_text: string;
  status: DiscordSuggestionStatus;
  created_at: string;
  updated_at: string;
};

export type DiscordCommandRegistrationRow = {
  id: string;
  installation_id: string;
  application_id: string;
  guild_id: string | null;
  commands_json: string;
  status: "registered" | "failed";
  response_json: string;
  created_at: string;
};

export type DiscordReadiness = {
  ready: boolean;
  mode: "relay-discord-interactions";
  interactionUrl: string;
  checks: Array<{ key: string; ok: boolean; detail: string }>;
};
