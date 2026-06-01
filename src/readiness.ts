import { isValidEncryptionKey } from "./crypto";
import {
  discordApplicationCommands,
  discordHostedInstallPermissions,
} from "./discord";
import type { RelayEnv } from "./env";
import { discordInteractionUrl, discordRedirectUri, redact } from "./http";
import {
  getDiscordConfig,
  getDiscordOperatorRoleId,
  getGrant,
  getInstallation,
  getLatestDiscordCommandRegistration,
} from "./repositories";
import { missingScopes } from "./twitch";
import type {
  DiscordInteractionRow,
  OutboundChatSendRow,
  RelayBotReadinessReport,
  RelayFreshness,
  RelayQueueHealth,
  RelayReadiness,
  RelaySchemaReadiness,
  DiscordReadiness,
  OAuthGrantRow,
} from "./types";
import { requiredBotScopes, requiredBroadcasterScopes } from "./types";

export const getReadiness = async (
  env: RelayEnv,
  installationId: string,
): Promise<RelayReadiness> => {
  const installation = await getInstallation(env, installationId);
  const botGrant = await getGrant(env, installationId, "bot");
  const broadcasterGrant = await getGrant(env, installationId, "broadcaster");
  const botScopes = botGrant
    ? (JSON.parse(botGrant.scopes_json) as string[])
    : [];
  const broadcasterScopes = broadcasterGrant
    ? (JSON.parse(broadcasterGrant.scopes_json) as string[])
    : [];
  const accountSeparation = botAccountSeparationReadiness(
    botGrant,
    broadcasterGrant,
  );
  const checks = [
    {
      key: "twitch-client-id",
      ok: Boolean(env.TWITCH_CLIENT_ID),
      detail: env.TWITCH_CLIENT_ID
        ? "Twitch client ID is configured."
        : "Set TWITCH_CLIENT_ID with wrangler secret put.",
    },
    {
      key: "twitch-client-secret",
      ok: Boolean(env.TWITCH_CLIENT_SECRET),
      detail: env.TWITCH_CLIENT_SECRET
        ? "Twitch client secret is configured."
        : "Set TWITCH_CLIENT_SECRET with wrangler secret put.",
    },
    {
      key: "eventsub-secret",
      ok: Boolean(env.TWITCH_EVENTSUB_SECRET),
      detail: env.TWITCH_EVENTSUB_SECRET
        ? "Twitch EventSub secret is configured."
        : "Set TWITCH_EVENTSUB_SECRET with wrangler secret put.",
    },
    {
      key: "token-encryption-key",
      ok: isValidEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
      detail: isValidEncryptionKey(env.TOKEN_ENCRYPTION_KEY)
        ? "Token encryption key is configured with 32 bytes of key material."
        : "Set TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key.",
    },
    {
      key: "public-base-url",
      ok:
        env.PUBLIC_BASE_URL?.startsWith("https://") ||
        env.PUBLIC_BASE_URL?.includes("127.0.0.1"),
      detail: env.PUBLIC_BASE_URL?.startsWith("https://")
        ? "Relay public base URL is HTTPS."
        : "Set PUBLIC_BASE_URL to the deployed HTTPS Worker URL before live validation.",
    },
    {
      key: "installation",
      ok: Boolean(installation),
      detail: installation
        ? "Relay installation exists."
        : "Pair Console with Relay.",
    },
    {
      key: "bot-grant",
      ok:
        Boolean(botGrant) &&
        missingScopes(botScopes, requiredBotScopes).length === 0,
      detail: botGrant
        ? `Bot grant stored for ${botGrant.login}.`
        : "Authorize vaexcorebot with user:bot, user:read:chat, and user:write:chat.",
    },
    {
      key: "broadcaster-grant",
      ok:
        Boolean(broadcasterGrant) &&
        missingScopes(broadcasterScopes, requiredBroadcasterScopes).length ===
          0,
      detail: broadcasterGrant
        ? `Broadcaster grant stored for ${broadcasterGrant.login}.`
        : "Authorize the broadcaster with channel:bot.",
    },
    {
      key: "separate-bot-account",
      ok: accountSeparation.ok,
      detail: accountSeparation.detail,
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    mode: "relay-chatbot",
    checks,
  };
};

const botAccountSeparationReadiness = (
  botGrant: OAuthGrantRow | null,
  broadcasterGrant: OAuthGrantRow | null,
) => {
  if (!botGrant || !broadcasterGrant) {
    return {
      ok: false,
      detail:
        "Complete both bot and broadcaster OAuth grants before confirming account separation.",
    };
  }
  if (botGrant.user_id === broadcasterGrant.user_id) {
    return {
      ok: false,
      detail: "Twitch will not show the broadcaster account as a chatbot.",
    };
  }
  return { ok: true, detail: "Bot and broadcaster accounts are separate." };
};

export const getDiscordReadiness = async (
  env: RelayEnv,
  installationId: string,
): Promise<DiscordReadiness> => {
  const [installation, latestRegistration, operatorRoleId, config] =
    await Promise.all([
      getInstallation(env, installationId),
      getLatestDiscordCommandRegistration(env, installationId),
      getDiscordOperatorRoleId(env, installationId),
      getDiscordConfig(env, installationId),
    ]);
  const interactionUrl = discordInteractionUrl(env);
  const guildId = config?.guild_id || env.DISCORD_GUILD_ID;
  const checks = [
    {
      key: "installation",
      ok: Boolean(installation),
      detail: installation
        ? "Relay installation exists."
        : "Pair Console with Relay.",
    },
    {
      key: "discord-bot-token",
      ok: Boolean(env.DISCORD_BOT_TOKEN),
      detail: env.DISCORD_BOT_TOKEN
        ? "Discord bot token is configured as a Worker secret."
        : "Set DISCORD_BOT_TOKEN with wrangler secret put.",
    },
    {
      key: "discord-public-key",
      ok: Boolean(env.DISCORD_PUBLIC_KEY),
      detail: env.DISCORD_PUBLIC_KEY
        ? "Discord interaction public key is configured."
        : "Set DISCORD_PUBLIC_KEY from the Discord application.",
    },
    {
      key: "discord-application-id",
      ok: Boolean(env.DISCORD_APPLICATION_ID),
      detail: env.DISCORD_APPLICATION_ID
        ? "Discord application ID is configured."
        : "Set DISCORD_APPLICATION_ID.",
    },
    {
      key: "discord-client-secret",
      ok: Boolean(env.DISCORD_CLIENT_SECRET),
      detail: env.DISCORD_CLIENT_SECRET
        ? "Discord client secret is configured as a Worker secret."
        : "Set DISCORD_CLIENT_SECRET with wrangler secret put.",
    },
    {
      key: "discord-guild-id",
      ok: Boolean(guildId),
      detail: guildId
        ? config?.guild_id
          ? `Discord is connected to ${config.guild_name || "the selected server"}.`
          : "Guild-scoped Discord command registration is configured from the environment fallback."
        : "Connect Discord from Console before live validation.",
    },
    {
      key: "discord-operator-role",
      ok: Boolean(operatorRoleId),
      detail: operatorRoleId
        ? "Discord operator role is configured."
        : "Apply Console Discord setup or set DISCORD_OPERATOR_ROLE_ID.",
    },
    {
      key: "discord-interaction-url",
      ok:
        interactionUrl.startsWith("https://") ||
        interactionUrl.includes("127.0.0.1"),
      detail: `Use ${interactionUrl} as the Discord Interactions Endpoint URL.`,
    },
    {
      key: "discord-command-registration",
      ok: latestRegistration?.status === "registered",
      detail:
        latestRegistration?.status === "registered"
          ? `Slash commands were registered at ${latestRegistration.created_at}.`
          : "Register Discord slash commands from Console.",
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    mode: "relay-discord-interactions",
    interactionUrl,
    checks,
  };
};

const requiredTables = [
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
] as const;

export const getSchemaReadiness = async (
  env: RelayEnv,
): Promise<RelaySchemaReadiness> => {
  const [tables, migrations] = await Promise.all([
    getTableReadiness(env),
    getMigrationReadiness(env),
  ]);
  const missingTables = tables
    .filter((table) => !table.exists)
    .map((table) => table.name);
  return {
    ready: missingTables.length === 0,
    requiredTables: tables.length,
    presentTables: tables.length - missingTables.length,
    missingTables,
    tables,
    migrations,
  };
};

const getMigrationReadiness = async (
  env: RelayEnv,
): Promise<RelaySchemaReadiness["migrations"]> => {
  try {
    const [count, latest] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first<{
        count: number;
      }>(),
      env.DB.prepare(
        `
          SELECT name, applied_at
          FROM d1_migrations
          ORDER BY applied_at DESC, name DESC
          LIMIT 1
        `,
      ).first<{ name: string; applied_at: string }>(),
    ]);
    return {
      tablePresent: true,
      appliedCount: count?.count ?? 0,
      latestName: latest?.name ?? "",
      latestAppliedAt: latest?.applied_at ?? "",
    };
  } catch {
    return {
      tablePresent: false,
      appliedCount: 0,
      latestName: "",
      latestAppliedAt: "",
    };
  }
};

const getTableReadiness = async (env: RelayEnv) => {
  const rows = await env.DB.prepare(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `,
  ).all<{ name: string }>();
  const names = new Set(rows.results.map((row) => row.name));
  return requiredTables.map((name) => ({ name, exists: names.has(name) }));
};

export const getQueueHealth = async (
  env: RelayEnv,
  installationId: string,
): Promise<RelayQueueHealth> => {
  const generatedAt = new Date().toISOString();
  const [chatEvents, discordInteractions, outboundRetry] = await Promise.all([
    env.DB.prepare(
      `
        SELECT COUNT(*) AS count, MIN(received_at) AS oldest_received_at
        FROM chat_events
        WHERE installation_id = ? AND delivered_at IS NULL
      `,
    )
      .bind(installationId)
      .first<{ count: number; oldest_received_at: string | null }>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at
        FROM discord_interactions
        WHERE installation_id = ? AND status = 'queued' AND delivered_at IS NULL
      `,
    )
      .bind(installationId)
      .first<{ count: number; oldest_created_at: string | null }>(),
    env.DB.prepare(
      `
        SELECT
          SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry,
          SUM(CASE WHEN status = 'retry' AND (next_retry_at IS NULL OR next_retry_at <= ?) THEN 1 ELSE 0 END) AS due_retry,
          SUM(CASE WHEN dead_lettered_at IS NULL THEN 0 ELSE 1 END) AS dead_lettered,
          MIN(CASE WHEN status = 'retry' THEN next_retry_at ELSE NULL END) AS oldest_next_retry_at,
          MAX(dead_lettered_at) AS latest_dead_lettered_at
        FROM outbound_chat_sends
        WHERE installation_id = ?
      `,
    )
      .bind(generatedAt, installationId)
      .first<{
        retry: number | null;
        due_retry: number | null;
        dead_lettered: number | null;
        oldest_next_retry_at: string | null;
        latest_dead_lettered_at: string | null;
      }>(),
  ]);
  return {
    generatedAt,
    twitchChatEvents: {
      queued: chatEvents?.count ?? 0,
      oldestReceivedAt: chatEvents?.oldest_received_at ?? "",
      oldestAgeMs: ageMs(generatedAt, chatEvents?.oldest_received_at),
    },
    discordInteractions: {
      queued: discordInteractions?.count ?? 0,
      oldestCreatedAt: discordInteractions?.oldest_created_at ?? "",
      oldestAgeMs: ageMs(generatedAt, discordInteractions?.oldest_created_at),
    },
    outboundRetry: {
      retry: outboundRetry?.retry ?? 0,
      dueRetry: outboundRetry?.due_retry ?? 0,
      deadLettered: outboundRetry?.dead_lettered ?? 0,
      oldestNextRetryAt: outboundRetry?.oldest_next_retry_at ?? "",
      oldestRetryAgeMs: ageMs(generatedAt, outboundRetry?.oldest_next_retry_at),
      latestDeadLetteredAt: outboundRetry?.latest_dead_lettered_at ?? "",
    },
  };
};

export const getFreshness = async (
  env: RelayEnv,
  installationId: string,
): Promise<RelayFreshness> => {
  const generatedAt = new Date().toISOString();
  const [eventSub, discordCommandRegistration] = await Promise.all([
    env.DB.prepare(
      `
        SELECT status, updated_at
        FROM eventsub_subscriptions
        WHERE installation_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
      .bind(installationId)
      .first<{ status: string; updated_at: string }>(),
    env.DB.prepare(
      `
        SELECT status, created_at
        FROM discord_command_registrations
        WHERE installation_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
      .bind(installationId)
      .first<{ status: string; created_at: string }>(),
  ]);
  return {
    eventSub: {
      present: Boolean(eventSub),
      latestStatus: eventSub?.status ?? "",
      latestUpdatedAt: eventSub?.updated_at ?? "",
      ageMs: ageMs(generatedAt, eventSub?.updated_at),
    },
    discordCommandRegistration: {
      present: Boolean(discordCommandRegistration),
      latestStatus: discordCommandRegistration?.status ?? "",
      latestCreatedAt: discordCommandRegistration?.created_at ?? "",
      ageMs: ageMs(generatedAt, discordCommandRegistration?.created_at),
    },
  };
};

export const getLatestReadinessRecords = async (
  env: RelayEnv,
  installationId: string,
): Promise<RelayBotReadinessReport["latest"]> => {
  const [eventSubRegistration, discordCommandRegistration, outboundSend] =
    await Promise.all([
      env.DB.prepare(
        `
          SELECT twitch_subscription_id, type, version, status, condition_json, created_at, updated_at
          FROM eventsub_subscriptions
          WHERE installation_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
        .bind(installationId)
        .first<Record<string, unknown>>(),
      env.DB.prepare(
        `
          SELECT application_id, guild_id, status, response_json, created_at
          FROM discord_command_registrations
          WHERE installation_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
        .bind(installationId)
        .first<Record<string, unknown>>(),
      env.DB.prepare(
        `
          SELECT status, twitch_message_id, failure_category, reason, retry_after_ms,
            retry_count, next_retry_at, dead_lettered_at, final_drop_reason, created_at, updated_at
          FROM outbound_chat_sends
          WHERE installation_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
        .bind(installationId)
        .first<Record<string, unknown>>(),
    ]);
  return {
    eventSubRegistration: eventSubRegistration
      ? (redact(eventSubRegistration) as Record<string, unknown>)
      : null,
    discordCommandRegistration: discordCommandRegistration
      ? (redact(discordCommandRegistration) as Record<string, unknown>)
      : null,
    outboundSend: outboundSend
      ? (redact(outboundSend) as Record<string, unknown>)
      : null,
  };
};

export const latestRecordMetadata = (
  latest: RelayBotReadinessReport["latest"],
): RelayBotReadinessReport["latestRecordMetadata"] => ({
  eventSubRegistration: recordMetadata(latest.eventSubRegistration, [
    "status",
    "type",
    "version",
    "created_at",
    "updated_at",
  ]),
  discordCommandRegistration: recordMetadata(
    latest.discordCommandRegistration,
    ["status", "application_id", "guild_id", "created_at"],
  ),
  outboundSend: recordMetadata(latest.outboundSend, [
    "status",
    "failure_category",
    "retry_count",
    "next_retry_at",
    "dead_lettered_at",
    "created_at",
    "updated_at",
  ]),
});

const recordMetadata = (
  record: Record<string, unknown> | null,
  fields: string[],
) => {
  if (!record) return { present: false };
  return {
    present: true,
    ...Object.fromEntries(fields.map((field) => [field, record[field] ?? ""])),
  };
};

export const ageMs = (
  generatedAt: string,
  timestamp: string | null | undefined,
) => {
  if (!timestamp) return null;
  const generated = Date.parse(generatedAt);
  const then = Date.parse(timestamp);
  if (!Number.isFinite(generated) || !Number.isFinite(then)) return null;
  return Math.max(0, generated - then);
};
