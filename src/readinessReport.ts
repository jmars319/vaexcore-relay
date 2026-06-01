import type { RelayEnv } from "./env";
import { discordInteractionUrl } from "./http";
import {
  getDiscordReadiness,
  getFreshness,
  getLatestReadinessRecords,
  getQueueHealth,
  getReadiness,
  getSchemaReadiness,
  latestRecordMetadata,
} from "./readiness";
import type {
  InstallationRow,
  RelayBotReadinessReport,
  RelayFreshness,
  RelayQueueHealth,
  RelaySchemaReadiness,
} from "./types";

export const getBotReadinessReport = async (
  env: RelayEnv,
  installation: InstallationRow,
): Promise<RelayBotReadinessReport> => {
  const [twitch, discord, schema, counts, latest, queues, freshness] =
    await Promise.all([
      getReadiness(env, installation.id),
      getDiscordReadiness(env, installation.id),
      getSchemaReadiness(env),
      getReadinessCounts(env, installation.id),
      getLatestReadinessRecords(env, installation.id),
      getQueueHealth(env, installation.id),
      getFreshness(env, installation.id),
    ]);
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? "";
  const checks: RelayBotReadinessReport["checks"] = [
    ...schema.tables.map(
      (table): RelayBotReadinessReport["checks"][number] => ({
        key: `d1-table-${table.name}`,
        ok: table.exists,
        state: table.exists ? "ready" : "blocked",
        detail: table.exists
          ? `${table.name} table exists.`
          : `${table.name} table is missing; apply D1 migrations.`,
      }),
    ),
    ...twitch.checks.map(
      (check): RelayBotReadinessReport["checks"][number] => ({
        ...check,
        state: check.ok ? "ready" : "todo",
      }),
    ),
    ...discord.checks.map(
      (check): RelayBotReadinessReport["checks"][number] => ({
        ...check,
        state: check.ok ? "ready" : "todo",
      }),
    ),
    {
      key: "latest-eventsub-registration",
      ok: Boolean(latest.eventSubRegistration),
      state: latest.eventSubRegistration ? "ready" : "todo",
      detail: latest.eventSubRegistration
        ? `Latest EventSub registration status is ${latest.eventSubRegistration.status}.`
        : "Register EventSub from Console after Twitch OAuth grants are ready.",
    },
    {
      key: "eventsub-freshness",
      ok: freshness.eventSub.present,
      state: freshness.eventSub.present ? "ready" : "todo",
      detail: freshness.eventSub.present
        ? `Latest EventSub registration updated at ${freshness.eventSub.latestUpdatedAt}.`
        : "No EventSub registration record exists yet.",
    },
    {
      key: "discord-command-registration-freshness",
      ok: freshness.discordCommandRegistration.present,
      state: freshness.discordCommandRegistration.present ? "ready" : "todo",
      detail: freshness.discordCommandRegistration.present
        ? `Latest Discord command registration was ${freshness.discordCommandRegistration.latestStatus} at ${freshness.discordCommandRegistration.latestCreatedAt}.`
        : "No Discord slash command registration record exists yet.",
    },
    {
      key: "outbound-retry-queue",
      ok: queues.outboundRetry.dueRetry === 0,
      state: queues.outboundRetry.dueRetry === 0 ? "ready" : "degraded",
      detail:
        queues.outboundRetry.dueRetry === 0
          ? "No outbound chat retries are due right now."
          : `${queues.outboundRetry.dueRetry} outbound chat retry item(s) are due.`,
    },
    {
      key: "outbound-dead-letter",
      ok: queues.outboundRetry.deadLettered === 0,
      state: queues.outboundRetry.deadLettered === 0 ? "ready" : "degraded",
      detail:
        queues.outboundRetry.deadLettered === 0
          ? "No outbound chat sends are dead-lettered."
          : `${queues.outboundRetry.deadLettered} outbound chat send(s) are dead-lettered.`,
    },
    {
      key: "latest-outbound-send",
      ok: latest.outboundSend?.status === "sent",
      state:
        latest.outboundSend?.status === "sent"
          ? "ready"
          : latest.outboundSend
            ? "degraded"
            : "todo",
      detail: latest.outboundSend
        ? `Latest outbound send status is ${latest.outboundSend.status}.`
        : "Send a Relay test message from Console after grants are ready.",
    },
  ];
  const generatedAt = new Date().toISOString();
  return {
    ok: true,
    generatedAt,
    summary: relayBotReadinessSummary(checks, generatedAt),
    codeReadiness: relayCodeReadinessSummary({
      generatedAt,
      schema,
      queues,
      freshness,
      latestRecordMetadata: latestRecordMetadata(latest),
    }),
    installation: {
      id: installation.id,
      name: installation.name,
      botLogin: installation.bot_login ?? "",
      broadcasterLogin: installation.broadcaster_login ?? "",
    },
    urls: {
      publicBaseUrl,
      twitchCallbackUrl: publicBaseUrl
        ? `${publicBaseUrl}/oauth/twitch/callback`
        : "",
      twitchEventSubWebhookUrl: publicBaseUrl
        ? `${publicBaseUrl}/webhooks/twitch/eventsub`
        : "",
      discordInteractionUrl: discordInteractionUrl(env),
    },
    checks,
    counts,
    schema,
    queues,
    freshness,
    latest,
    latestRecordMetadata: latestRecordMetadata(latest),
  };
};

const relayBotReadinessSummary = (
  checks: RelayBotReadinessReport["checks"],
  generatedAt: string,
): RelayBotReadinessReport["summary"] => {
  const readyCount = checks.filter((check) => check.state === "ready").length;
  const todoCount = checks.filter((check) => check.state === "todo").length;
  const degradedCount = checks.filter(
    (check) => check.state === "degraded",
  ).length;
  const blockedCount = checks.filter(
    (check) => check.state === "blocked",
  ).length;
  if (blockedCount > 0) {
    return {
      state: "failed",
      detail: `${blockedCount} required Relay code or data check(s) are blocked.`,
      lastCheckedAt: generatedAt,
      readyCount,
      todoCount,
      degradedCount,
      blockedCount,
    };
  }
  if (degradedCount > 0) {
    return {
      state: "degraded",
      detail: `${degradedCount} Relay check(s) are degraded; code paths remain inspectable.`,
      lastCheckedAt: generatedAt,
      readyCount,
      todoCount,
      degradedCount,
      blockedCount,
    };
  }
  if (todoCount > 0) {
    return {
      state: "app-check-available",
      detail: `${todoCount} app-integrated setup check(s) have not been recorded yet.`,
      lastCheckedAt: generatedAt,
      readyCount,
      todoCount,
      degradedCount,
      blockedCount,
    };
  }
  return {
    state: "ready",
    detail: "Relay code, queue, schema, and setup checks are ready.",
    lastCheckedAt: generatedAt,
    readyCount,
    todoCount,
    degradedCount,
    blockedCount,
  };
};

const relayCodeReadinessSummary = ({
  generatedAt,
  schema,
  queues,
  freshness,
  latestRecordMetadata,
}: {
  generatedAt: string;
  schema: RelaySchemaReadiness;
  queues: RelayQueueHealth;
  freshness: RelayFreshness;
  latestRecordMetadata: RelayBotReadinessReport["codeReadiness"]["latestRecordMetadata"];
}): RelayBotReadinessReport["codeReadiness"] => {
  const retryReady = queues.outboundRetry.dueRetry === 0;
  const deadLetterReady = queues.outboundRetry.deadLettered === 0;
  const queueReady = retryReady && deadLetterReady;
  const eventSubFresh = freshness.eventSub.present;
  const discordCommandsFresh = freshness.discordCommandRegistration.present;
  const blocked = !schema.ready;
  const degraded =
    !blocked && (!queueReady || !eventSubFresh || !discordCommandsFresh);
  const state = blocked ? "blocked" : degraded ? "degraded" : "ready";
  const detail =
    state === "ready"
      ? "Relay schema, queues, freshness, and latest-record metadata are code-ready."
      : state === "blocked"
        ? "Relay D1 schema is missing required tables or migrations."
        : "Relay code is inspectable, with queue or freshness items needing operator attention.";
  return {
    state,
    detail,
    lastCheckedAt: generatedAt,
    schemaReady: schema.ready,
    queueReady,
    retryReady,
    deadLetterReady,
    eventSubFresh,
    discordCommandsFresh,
    queueAges: {
      twitchChatOldestAgeMs: queues.twitchChatEvents.oldestAgeMs,
      discordInteractionOldestAgeMs: queues.discordInteractions.oldestAgeMs,
      outboundRetryOldestAgeMs: queues.outboundRetry.oldestRetryAgeMs,
    },
    latestRecordMetadata,
  };
};

const getReadinessCounts = async (
  env: RelayEnv,
  installationId: string,
): Promise<RelayBotReadinessReport["counts"]> => {
  const [
    queuedTwitchChatEvents,
    queuedDiscordInteractions,
    outboundRows,
    suggestionRows,
  ] = await Promise.all([
    countRows(
      env,
      "chat_events",
      "installation_id = ? AND delivered_at IS NULL",
      installationId,
    ),
    countRows(
      env,
      "discord_interactions",
      "installation_id = ? AND status = 'queued' AND delivered_at IS NULL",
      installationId,
    ),
    env.DB.prepare(
      `
        SELECT status, COUNT(*) AS count,
          SUM(CASE WHEN dead_lettered_at IS NULL THEN 0 ELSE 1 END) AS dead_lettered
        FROM outbound_chat_sends
        WHERE installation_id = ?
        GROUP BY status
      `,
    )
      .bind(installationId)
      .all<{
        status: RelayBotReadinessReport["counts"]["outboundSends"] extends infer T
          ? keyof T
          : never;
        count: number;
        dead_lettered: number | null;
      }>(),
    env.DB.prepare(
      `
        SELECT status, COUNT(*) AS count
        FROM discord_suggestions
        WHERE installation_id = ?
        GROUP BY status
      `,
    )
      .bind(installationId)
      .all<{
        status: keyof RelayBotReadinessReport["counts"]["suggestions"];
        count: number;
      }>(),
  ]);
  const outboundSends = {
    queued: 0,
    sent: 0,
    retry: 0,
    failed: 0,
    deadLettered: 0,
  };
  for (const row of outboundRows.results) {
    outboundSends[row.status] = row.count;
    outboundSends.deadLettered += row.dead_lettered ?? 0;
  }
  const suggestions = {
    new: 0,
    reviewed: 0,
    accepted: 0,
    rejected: 0,
    archived: 0,
  };
  for (const row of suggestionRows.results) suggestions[row.status] = row.count;
  return {
    queuedTwitchChatEvents,
    queuedDiscordInteractions,
    suggestions,
    outboundSends,
  };
};

const countRows = async (
  env: RelayEnv,
  table: string,
  whereClause: string,
  installationId: string,
) => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`,
  )
    .bind(installationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};
