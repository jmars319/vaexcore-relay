import assert from "node:assert/strict";
import test from "node:test";
import relayWorker, { outboundSendPersistence } from "../src/index";
import { sha256Base64Url } from "../src/crypto";

test("outboundSendPersistence records retry and dead-letter metadata", () => {
  assert.deepEqual(
    outboundSendPersistence({
      sent: true,
      retryAfterMs: null,
      fallbackReason: "unused",
      now: "2026-05-13T12:00:00.000Z",
    }),
    {
      status: "sent",
      reason: null,
      retryAfterMs: null,
      retryCount: 0,
      nextRetryAt: null,
      deadLetteredAt: null,
      finalDropReason: null,
    },
  );

  assert.deepEqual(
    outboundSendPersistence({
      sent: false,
      retryAfterMs: 15_000,
      fallbackReason: "rate limited",
      now: "2026-05-13T12:00:00.000Z",
    }),
    {
      status: "retry",
      reason: "rate limited",
      retryAfterMs: 15_000,
      retryCount: 1,
      nextRetryAt: "2026-05-13T12:00:15.000Z",
      deadLetteredAt: null,
      finalDropReason: null,
    },
  );

  assert.deepEqual(
    outboundSendPersistence({
      sent: false,
      retryAfterMs: null,
      fallbackReason: "Twitch response 403",
      now: "2026-05-13T12:00:00.000Z",
    }),
    {
      status: "failed",
      reason: "Twitch response 403",
      retryAfterMs: null,
      retryCount: 1,
      nextRetryAt: null,
      deadLetteredAt: "2026-05-13T12:00:00.000Z",
      finalDropReason: "Twitch response 403",
    },
  );
});

test("console readiness report is redacted and includes queue counts", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken));
  const response = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/readiness-report?installationId=installation-1",
      { headers: { authorization: `Bearer ${consoleToken}` } },
    ),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.installation.id, "installation-1");
  assert.equal(
    body.urls.twitchCallbackUrl,
    "https://relay.example/oauth/twitch/callback",
  );
  assert.equal(body.counts.queuedTwitchChatEvents, 2);
  assert.equal(body.counts.queuedDiscordInteractions, 1);
  assert.equal(body.counts.suggestions.new, 3);
  assert.equal(body.counts.outboundSends.deadLettered, 1);
  assert.equal(body.latest.outboundSend.final_drop_reason, "denied");
  assert.equal(JSON.stringify(body).includes("console-token"), false);
  assert.equal(JSON.stringify(body).includes("actual-secret-value"), false);
});

const fakeEnv = (consoleTokenHash: string) =>
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
    DISCORD_GUILD_ID: "discord-guild",
    DISCORD_OPERATOR_ROLE_ID: "operator-role",
    DB: fakeDb(consoleTokenHash),
  }) as any;

const fakeExecutionContext = () =>
  ({
    waitUntil() {},
    passThroughOnException() {},
  }) as any;

const fakeDb = (consoleTokenHash: string) => ({
  prepare(sql: string) {
    const statement = {
      bindings: [] as unknown[],
      bind(...values: unknown[]) {
        this.bindings = values;
        return this;
      },
      async first<T>() {
        return firstForSql(sql, this.bindings, consoleTokenHash) as T | null;
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
    const kind = bindings[1];
    const isBot = kind === "bot";
    return {
      installation_id: "installation-1",
      grant_kind: kind,
      user_id: isBot ? "bot-1" : "broadcaster-1",
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
      response_json: "{}",
      created_at: "2026-05-13T12:02:00.000Z",
    };
  }
  if (sql.includes("FROM eventsub_subscriptions")) {
    return {
      twitch_subscription_id: "sub-1",
      type: "channel.chat.message",
      version: "1",
      status: "created",
      condition_json: "{}",
      created_at: "2026-05-13T12:01:00.000Z",
      updated_at: "2026-05-13T12:01:00.000Z",
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
