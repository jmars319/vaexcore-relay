import assert from "node:assert/strict";
import test from "node:test";
import relayWorker, {
  outboundRetryPersistence,
  outboundSendPersistence,
  processOutboundRetryQueue,
} from "../src/index";
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

test("outboundRetryPersistence retries until max attempts then dead-letters", () => {
  assert.deepEqual(
    outboundRetryPersistence({
      sent: false,
      retryAfterMs: 30_000,
      fallbackReason: "rate limited",
      now: "2026-05-13T12:00:00.000Z",
      currentRetryCount: 1,
      maxRetryCount: 3,
    }),
    {
      status: "retry",
      reason: "rate limited",
      retryAfterMs: 30_000,
      retryCount: 2,
      nextRetryAt: "2026-05-13T12:00:30.000Z",
      deadLetteredAt: null,
      finalDropReason: null,
      updatedAt: "2026-05-13T12:00:00.000Z",
    },
  );

  assert.deepEqual(
    outboundRetryPersistence({
      sent: false,
      retryAfterMs: 30_000,
      fallbackReason: "still rate limited",
      now: "2026-05-13T12:01:00.000Z",
      currentRetryCount: 2,
      maxRetryCount: 3,
    }),
    {
      status: "failed",
      reason: "still rate limited",
      retryAfterMs: 30_000,
      retryCount: 3,
      nextRetryAt: null,
      deadLetteredAt: "2026-05-13T12:01:00.000Z",
      finalDropReason: "still rate limited",
      updatedAt: "2026-05-13T12:01:00.000Z",
    },
  );
});

test("processOutboundRetryQueue sends due retry rows", async () => {
  const db = retryDb();
  const env = {
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    DB: db,
  } as any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      return Response.json({
        access_token: "app-token",
        expires_in: 3600,
        token_type: "bearer",
      });
    }
    if (url.includes("/chat/messages")) {
      return Response.json({
        data: [{ message_id: "retry-message-1", is_sent: true }],
      });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as typeof fetch;

  try {
    const summary = await processOutboundRetryQueue(env, {
      now: "2026-05-13T12:00:00.000Z",
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.sent, 1);
    const update = db.updates[0];
    const audit = db.audits[0];
    assert(update, "retry worker should update the send row");
    assert(audit, "retry worker should write an audit event");
    assert.equal(update.status, "sent");
    assert.equal(update.twitchMessageId, "retry-message-1");
    assert.equal(audit.action, "chat.retry.sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.equal(body.schema.ready, true);
  assert.equal(body.schema.presentTables, body.schema.requiredTables);
  assert.equal(body.schema.migrations.appliedCount, 3);
  assert.equal(body.queues.twitchChatEvents.queued, 2);
  assert.equal(
    body.queues.twitchChatEvents.oldestReceivedAt,
    "2026-05-13T11:55:00.000Z",
  );
  assert.equal(body.queues.outboundRetry.dueRetry, 1);
  assert.equal(body.queues.outboundRetry.deadLettered, 1);
  assert.equal(body.freshness.eventSub.latestStatus, "created");
  assert.equal(
    body.freshness.discordCommandRegistration.latestStatus,
    "registered",
  );
  assert.equal(body.latest.outboundSend.final_drop_reason, "denied");
  assert.equal(body.latestRecordMetadata.outboundSend.status, "failed");
  assert.equal(
    body.latestRecordMetadata.discordCommandRegistration.present,
    true,
  );
  assert.equal(body.summary.state, "degraded");
  assert.equal(body.summary.lastCheckedAt, body.generatedAt);
  assert.ok(body.summary.readyCount > 0);
  assert.equal(JSON.stringify(body).includes("console-token"), false);
  assert.equal(JSON.stringify(body).includes("actual-secret-value"), false);
  assert.equal(JSON.stringify(body).includes("discord-token"), false);
  assert.equal(JSON.stringify(body).includes("oauth-response-secret"), false);
});

test("console readiness separates missing grants from account-separation validation", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken), {
    grants: "missing",
  });
  const response = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/status?installationId=installation-1",
      {
        headers: { authorization: `Bearer ${consoleToken}` },
      },
    ),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;
  const accountCheck = body.readiness.checks.find(
    (check: { key: string }) => check.key === "separate-bot-account",
  );

  assert.equal(response.status, 200);
  assert.equal(accountCheck.ok, false);
  assert.match(
    accountCheck.detail,
    /Complete both bot and broadcaster OAuth grants/,
  );
});

test("admin diagnostics are protected and redacted", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken));
  const unauthorized = await relayWorker.fetch(
    new Request("https://relay.example/admin/diagnostics"),
    env,
    fakeExecutionContext(),
  );
  assert.equal(unauthorized.status, 401);

  const response = await relayWorker.fetch(
    new Request("https://relay.example/admin/diagnostics", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configuration.hasDiscordBotToken, true);
  assert.equal(body.schema.ready, true);
  assert.equal(body.queues.outboundChatSends.deadLettered, 1);
  assert.equal(body.eventSub.staleCount, 0);
  assert.equal(JSON.stringify(body).includes("actual-secret-value"), false);
  assert.equal(JSON.stringify(body).includes("discord-token"), false);
});

type FakeDbOptions = {
  grants?: "ready" | "missing" | "same-account";
};

const fakeEnv = (consoleTokenHash: string, options: FakeDbOptions = {}) =>
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
    DB: fakeDb(consoleTokenHash, options),
  }) as any;

const fakeExecutionContext = () =>
  ({
    waitUntil() {},
    passThroughOnException() {},
  }) as any;

const retryDb = () => {
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
  if (sql.includes("COUNT(*) AS count FROM d1_migrations")) {
    return { count: 3 };
  }
  if (sql.includes("FROM d1_migrations")) {
    return {
      name: "0003_bot_readiness.sql",
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
