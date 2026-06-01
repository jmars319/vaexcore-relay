import { bytesToHex } from "../src/crypto";

const textEncoder = new TextEncoder();

export type FakeDbOptions = {
  grants?: "ready" | "missing" | "same-account";
  discordGuildEnv?: string | null;
  storedDiscordGuild?: boolean;
};

export const fakeEnv = (
  consoleTokenHash: string,
  options: FakeDbOptions = {},
) =>
  ({
    PUBLIC_BASE_URL: "https://relay.example",
    TWITCH_REDIRECT_URI: "https://relay.example/oauth/twitch/callback",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "actual-secret-value",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    RELAY_ADMIN_TOKEN: "admin-token",
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_PUBLIC_KEY: "public-key",
    DISCORD_APPLICATION_ID: "discord-app",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    ...(options.discordGuildEnv === null
      ? {}
      : { DISCORD_GUILD_ID: options.discordGuildEnv ?? "discord-guild" }),
    DISCORD_OPERATOR_ROLE_ID: "operator-role",
    DB: fakeDb(consoleTokenHash, options),
  }) as any;

export const fakeExecutionContext = () =>
  ({
    waitUntil() {},
    passThroughOnException() {},
  }) as any;

export const discordSigningFixture = async () => {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKeyHex: bytesToHex(new Uint8Array(publicKey)),
  };
};

export const signedDiscordInteractionRequest = async (
  privateKey: CryptoKey,
  commandName: string,
  options: { roles: string[]; permissions?: string },
) => {
  const timestamp = "2026-05-21T12:00:00.000Z";
  const body = JSON.stringify({
    id: `interaction-${commandName}`,
    application_id: "discord-app",
    type: 2,
    guild_id: "discord-guild",
    channel_id: "discord-channel",
    data: { name: commandName, options: [] },
    member: {
      user: { id: "discord-user", username: "operator" },
      roles: options.roles,
      permissions: options.permissions ?? "0",
    },
  });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    textEncoder.encode(`${timestamp}${body}`),
  );
  return new Request(
    "https://relay.example/webhooks/discord/interactions?installationId=installation-1",
    {
      method: "POST",
      headers: {
        "x-signature-ed25519": bytesToHex(new Uint8Array(signature)),
        "x-signature-timestamp": timestamp,
        "content-type": "application/json",
      },
      body,
    },
  );
};

export const discordInteractionEnv = (
  publicKeyHex: string,
  db: any,
  operatorRoleId?: string,
) =>
  ({
    PUBLIC_BASE_URL: "https://relay.example",
    TWITCH_REDIRECT_URI: "https://relay.example/oauth/twitch/callback",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "actual-secret-value",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    RELAY_ADMIN_TOKEN: "admin-token",
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "discord-app",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    DISCORD_GUILD_ID: "discord-guild",
    DISCORD_OPERATOR_ROLE_ID: operatorRoleId,
    DB: db,
  }) as any;

export const discordInstallEnv = (db: any) =>
  ({
    PUBLIC_BASE_URL: "https://relay.example",
    TWITCH_REDIRECT_URI: "https://relay.example/oauth/twitch/callback",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "actual-secret-value",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    RELAY_ADMIN_TOKEN: "admin-token",
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_PUBLIC_KEY: "public-key",
    DISCORD_APPLICATION_ID: "discord-app",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    DB: db,
  }) as any;

export const discordInstallCallbackDb = () => {
  const state = {
    config: null as null | { guildId: string; guildName: string | null },
    deletedState: "",
  };
  return {
    get config() {
      return state.config;
    },
    get deletedState() {
      return state.deletedState;
    },
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...values: unknown[]) {
          this.bindings = values;
          return this;
        },
        async first<T>() {
          if (sql.includes("FROM discord_install_states")) {
            return {
              installation_id: "installation-1",
              return_url: null,
              expires_at: "2999-01-01T00:00:00.000Z",
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("INSERT INTO discord_configs")) {
            state.config = {
              guildId: String(this.bindings[3]),
              guildName: this.bindings[4] as string | null,
            };
          }
          if (sql.includes("DELETE FROM discord_install_states")) {
            state.deletedState = String(this.bindings[0]);
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
};

export const discordInteractionDb = (operatorRoleId: string | null) => {
  const state = {
    operatorRoleId,
    interactions: [] as Array<{
      commandName: string;
      status: string;
      allowed: boolean;
    }>,
  };
  return {
    get interactions() {
      return state.interactions;
    },
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...values: unknown[]) {
          this.bindings = values;
          return this;
        },
        async first<T>() {
          if (sql.includes("SELECT * FROM installations WHERE id")) {
            return {
              id: "installation-1",
              name: "Console",
              console_token_hash: "unused",
              bot_user_id: "bot-1",
              bot_login: "vaexcorebot",
              broadcaster_user_id: "broadcaster-1",
              broadcaster_login: "vaexil",
              created_at: "2026-05-13T12:00:00.000Z",
              updated_at: "2026-05-13T12:00:00.000Z",
            } as T;
          }
          if (sql.includes("SELECT operator_role_id")) {
            return { operator_role_id: state.operatorRoleId } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO discord_interactions")) {
            const payload = JSON.parse(String(this.bindings[4]));
            state.interactions.push({
              commandName: String(payload.commandName),
              status: String(this.bindings[5]),
              allowed: Boolean(payload.allowed),
            });
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
};

export const retryDb = () => {
  const state = {
    row: {
      id: "send-retry-1",
      installation_id: "installation-1",
      broadcaster_user_id: "broadcaster-1",
      sender_user_id: "bot-1",
      message: "retry me",
      status: "retry",
      twitch_message_id: null,
      failure_category: "twitch_rejected",
      reason: "rate limited",
      retry_after_ms: 30_000,
      idempotency_key: "message-1",
      retry_count: 1,
      next_retry_at: "2026-05-13T11:59:00.000Z",
      dead_lettered_at: null,
      final_drop_reason: null,
      created_at: "2026-05-13T11:58:00.000Z",
      updated_at: "2026-05-13T11:58:00.000Z",
    },
    updates: [] as Array<{
      status: string;
      twitchMessageId: string | null;
      retryCount: number;
    }>,
    audits: [] as Array<{ action: string; target: string | null }>,
  };
  return {
    get updates() {
      return state.updates;
    },
    get audits() {
      return state.audits;
    },
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...values: unknown[]) {
          this.bindings = values;
          return this;
        },
        async all<T>() {
          if (sql.includes("FROM outbound_chat_sends")) {
            return { results: [state.row] as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          if (sql.includes("UPDATE outbound_chat_sends")) {
            state.updates.push({
              status: String(this.bindings[0]),
              twitchMessageId: this.bindings[1] as string | null,
              retryCount: Number(this.bindings[5]),
            });
          }
          if (sql.includes("INSERT INTO audit_events")) {
            state.audits.push({
              action: String(this.bindings[2]),
              target: this.bindings[3] as string | null,
            });
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
};

const fakeDb = (consoleTokenHash: string, options: FakeDbOptions = {}) => ({
  prepare(sql: string) {
    const statement = {
      bindings: [] as unknown[],
      bind(...values: unknown[]) {
        this.bindings = values;
        return this;
      },
      async first<T>() {
        return firstForSql(
          sql,
          this.bindings,
          consoleTokenHash,
          options,
        ) as T | null;
      },
      async all<T>() {
        return { results: allForSql(sql) as T[] };
      },
      async run() {
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  },
  async batch() {
    return [];
  },
});

const firstForSql = (
  sql: string,
  bindings: unknown[],
  consoleTokenHash: string,
  options: FakeDbOptions,
) => {
  if (sql.includes("SELECT * FROM installations WHERE id")) {
    return {
      id: "installation-1",
      name: "Console",
      console_token_hash: consoleTokenHash,
      bot_user_id: "bot-1",
      bot_login: "vaexcorebot",
      broadcaster_user_id: "broadcaster-1",
      broadcaster_login: "vaexil",
      created_at: "2026-05-13T12:00:00.000Z",
      updated_at: "2026-05-13T12:00:00.000Z",
    };
  }
  if (sql.includes("FROM oauth_grants") && sql.includes("grant_kind = ?")) {
    if (options.grants === "missing") {
      return null;
    }
    const kind = bindings[1];
    const isBot = kind === "bot";
    return {
      installation_id: "installation-1",
      grant_kind: kind,
      user_id:
        options.grants === "same-account"
          ? "shared-user"
          : isBot
            ? "bot-1"
            : "broadcaster-1",
      login: isBot ? "vaexcorebot" : "vaexil",
      scopes_json: JSON.stringify(
        isBot
          ? ["user:bot", "user:read:chat", "user:write:chat"]
          : ["channel:bot"],
      ),
      encrypted_access_token: "[encrypted]",
      encrypted_refresh_token: null,
      token_expires_at: "2026-05-13T13:00:00.000Z",
      updated_at: "2026-05-13T12:00:00.000Z",
    };
  }
  if (sql.includes("FROM discord_command_registrations")) {
    return {
      application_id: "discord-app",
      guild_id: "discord-guild",
      status: "registered",
      response_json:
        '{"authorization":"Bearer discord-token","secret":"oauth-response-secret"}',
      created_at: "2026-05-13T12:02:00.000Z",
    };
  }
  if (
    sql.includes("FROM discord_configs") &&
    sql.includes("WHERE installation_id = ?")
  ) {
    if (!options.storedDiscordGuild) return null;
    return {
      installation_id: "installation-1",
      application_id: "discord-app",
      guild_id: "stored-discord-guild",
      guild_name: "Stored Discord Server",
      operator_role_id: "operator-role",
      interaction_url: "https://relay.example/webhooks/discord/interactions",
      installed_at: "2026-05-13T12:01:00.000Z",
      setup_template_id: "full-creator-community",
      setup_applied_at: null,
      starter_messages_applied_at: null,
      stream_announcement_channel_id: null,
      general_announcement_channel_id: null,
      suggestion_channel_id: null,
      stream_alerts_role_id: null,
      created_channel_ids_json: "{}",
      created_role_ids_json: "{}",
      created_message_ids_json: "{}",
      updated_at: "2026-05-13T12:01:00.000Z",
    };
  }
  if (sql.includes("COUNT(*) AS count FROM d1_migrations")) {
    return { count: 4 };
  }
  if (sql.includes("FROM d1_migrations")) {
    return {
      name: "0004_discord_hosted_install.sql",
      applied_at: "2026-05-13T12:04:00.000Z",
    };
  }
  if (sql.includes("FROM eventsub_subscriptions")) {
    return {
      twitch_subscription_id: "sub-1",
      type: "channel.chat.message",
      version: "1",
      status: "created",
      condition_json: '{"oauth":"oauth-response-secret"}',
      created_at: "2026-05-13T12:01:00.000Z",
      updated_at: "2026-05-13T12:01:00.000Z",
    };
  }
  if (sql.includes("MIN(received_at)") && sql.includes("FROM chat_events")) {
    return {
      count: 2,
      oldest_received_at: "2026-05-13T11:55:00.000Z",
    };
  }
  if (
    sql.includes("MIN(created_at)") &&
    sql.includes("FROM discord_interactions")
  ) {
    return {
      count: 1,
      oldest_created_at: "2026-05-13T11:56:00.000Z",
    };
  }
  if (
    sql.includes("oldest_next_retry_at") &&
    sql.includes("FROM outbound_chat_sends")
  ) {
    return {
      retry: 1,
      due_retry: 1,
      dead_lettered: 1,
      oldest_next_retry_at: "2026-05-13T11:59:00.000Z",
      latest_dead_lettered_at: "2026-05-13T12:03:00.000Z",
    };
  }
  if (
    sql.includes("FROM outbound_chat_sends") &&
    sql.includes("ORDER BY created_at DESC")
  ) {
    return {
      status: "failed",
      twitch_message_id: null,
      failure_category: "twitch_rejected",
      reason: "denied",
      retry_after_ms: null,
      retry_count: 1,
      next_retry_at: null,
      dead_lettered_at: "2026-05-13T12:03:00.000Z",
      final_drop_reason: "denied",
      created_at: "2026-05-13T12:03:00.000Z",
      updated_at: "2026-05-13T12:03:00.000Z",
    };
  }
  if (sql.includes("COUNT(*) AS count FROM chat_events")) return { count: 2 };
  if (sql.includes("COUNT(*) AS count FROM discord_interactions"))
    return { count: 1 };
  return null;
};

const allForSql = (sql: string) => {
  if (sql.includes("FROM sqlite_master")) {
    return [
      "installations",
      "oauth_states",
      "oauth_grants",
      "eventsub_subscriptions",
      "chat_events",
      "outbound_chat_sends",
      "audit_events",
      "discord_configs",
      "discord_install_states",
      "discord_interactions",
      "discord_suggestions",
      "discord_command_registrations",
    ].map((name) => ({ name }));
  }
  if (
    sql.includes("FROM outbound_chat_sends") &&
    sql.includes("GROUP BY status")
  ) {
    return [
      { status: "sent", count: 5, dead_lettered: 0 },
      { status: "failed", count: 1, dead_lettered: 1 },
    ];
  }
  if (
    sql.includes("FROM discord_suggestions") &&
    sql.includes("GROUP BY status")
  ) {
    return [
      { status: "new", count: 3 },
      { status: "accepted", count: 1 },
    ];
  }
  return [];
};
