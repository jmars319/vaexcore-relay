import type { RelayEnv } from "./env";
import { serviceName, serviceVersion } from "./env";
import { discordInteractionUrl, discordRedirectUri, redact } from "./http";
import { getSchemaReadiness } from "./readiness";
import type { DiscordInteractionRow, OutboundChatSendRow } from "./types";

export const getAdminDiagnostics = async (env: RelayEnv) => {
  const [schema, queues, eventSub, discord, audit] = await Promise.all([
    getSchemaReadiness(env),
    getAdminQueueDiagnostics(env),
    getEventSubDiagnostics(env),
    getDiscordAdminDiagnostics(env),
    getAuditDiagnostics(env),
  ]);
  return {
    ok: true,
    service: serviceName,
    version: serviceVersion,
    generatedAt: new Date().toISOString(),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    configuration: {
      hasTwitchClientId: Boolean(env.TWITCH_CLIENT_ID),
      hasEventSubSecret: Boolean(env.TWITCH_EVENTSUB_SECRET),
      hasEncryptionKey: Boolean(env.TOKEN_ENCRYPTION_KEY),
      hasDiscordBotToken: Boolean(env.DISCORD_BOT_TOKEN),
      hasDiscordPublicKey: Boolean(env.DISCORD_PUBLIC_KEY),
      hasDiscordApplicationId: Boolean(env.DISCORD_APPLICATION_ID),
      hasDiscordClientSecret: Boolean(env.DISCORD_CLIENT_SECRET),
      hasDiscordGuildId: Boolean(env.DISCORD_GUILD_ID),
      discordInteractionUrl: discordInteractionUrl(env),
      discordRedirectUri: discordRedirectUri(env),
    },
    tables: schema.tables,
    schema,
    queues,
    eventSub,
    discord,
    audit,
  };
};

const getAdminQueueDiagnostics = async (env: RelayEnv) => {
  const now = new Date().toISOString();
  const [outboundRows, chatEvents, discordInteractions] = await Promise.all([
    env.DB.prepare(
      `
        SELECT status, COUNT(*) AS count,
          SUM(CASE WHEN dead_lettered_at IS NULL THEN 0 ELSE 1 END) AS dead_lettered,
          SUM(CASE WHEN status = 'retry' AND (next_retry_at IS NULL OR next_retry_at <= ?) THEN 1 ELSE 0 END) AS due_retry
        FROM outbound_chat_sends
        GROUP BY status
      `,
    )
      .bind(now)
      .all<{
        status: OutboundChatSendRow["status"];
        count: number;
        dead_lettered: number | null;
        due_retry: number | null;
      }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM chat_events WHERE delivered_at IS NULL",
    ).first<{ count: number }>(),
    env.DB.prepare(
      `
        SELECT status, COUNT(*) AS count
        FROM discord_interactions
        GROUP BY status
      `,
    ).all<{ status: DiscordInteractionRow["status"]; count: number }>(),
  ]);
  const outbound = {
    queued: 0,
    sent: 0,
    retry: 0,
    failed: 0,
    dueRetry: 0,
    deadLettered: 0,
  };
  for (const row of outboundRows.results) {
    outbound[row.status] = row.count;
    outbound.deadLettered += row.dead_lettered ?? 0;
    outbound.dueRetry += row.due_retry ?? 0;
  }
  return {
    generatedAt: now,
    outboundChatSends: outbound,
    queuedTwitchChatEvents: chatEvents?.count ?? 0,
    discordInteractions: Object.fromEntries(
      discordInteractions.results.map((row) => [row.status, row.count]),
    ),
  };
};

const getEventSubDiagnostics = async (env: RelayEnv) => {
  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [statusRows, stale] = await Promise.all([
    env.DB.prepare(
      `
        SELECT status, COUNT(*) AS count
        FROM eventsub_subscriptions
        GROUP BY status
      `,
    ).all<{ status: string; count: number }>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS count
        FROM eventsub_subscriptions
        WHERE updated_at < ?
      `,
    )
      .bind(staleCutoff)
      .first<{ count: number }>(),
  ]);
  return {
    staleCutoff,
    staleCount: stale?.count ?? 0,
    byStatus: Object.fromEntries(
      statusRows.results.map((row) => [row.status, row.count]),
    ),
  };
};

const getDiscordAdminDiagnostics = async (env: RelayEnv) => {
  const [configs, registrations] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM discord_configs").first<{
      count: number;
    }>(),
    env.DB.prepare(
      `
        SELECT installation_id, application_id, guild_id, status, response_json, created_at
        FROM discord_command_registrations
        ORDER BY created_at DESC
        LIMIT 10
      `,
    ).all<Record<string, unknown>>(),
  ]);
  return {
    configuredInstallations: configs?.count ?? 0,
    latestRegistrations: registrations.results.map((row) => redact(row)),
  };
};

const getAuditDiagnostics = async (env: RelayEnv) => {
  const rows = await env.DB.prepare(
    `
      SELECT installation_id, action, target, metadata_json, created_at
      FROM audit_events
      ORDER BY created_at DESC
      LIMIT 25
    `,
  ).all<Record<string, unknown>>();
  return { recent: rows.results.map((row) => redact(row)) };
};
