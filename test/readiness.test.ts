import assert from "node:assert/strict";
import test from "node:test";
import relayWorker, {
  outboundRetryPersistence,
  outboundSendPersistence,
  processOutboundRetryQueue,
} from "../src/index";
import { sha256Base64Url } from "../src/crypto";
import {
  discordInstallCallbackDb,
  discordInstallEnv,
  discordInteractionDb,
  discordInteractionEnv,
  discordSigningFixture,
  fakeEnv,
  fakeExecutionContext,
  retryDb,
  signedDiscordInteractionRequest,
} from "./relay-test-helpers";

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
  assert.equal(body.schema.migrations.appliedCount, 4);
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
  assert.equal(body.codeReadiness.state, "degraded");
  assert.equal(body.codeReadiness.schemaReady, true);
  assert.equal(body.codeReadiness.retryReady, false);
  assert.equal(body.codeReadiness.deadLetterReady, false);
  assert.equal(body.codeReadiness.eventSubFresh, true);
  assert.equal(body.codeReadiness.discordCommandsFresh, true);
  assert.equal(
    body.codeReadiness.queueAges.twitchChatOldestAgeMs,
    body.queues.twitchChatEvents.oldestAgeMs,
  );
  assert.equal(
    body.codeReadiness.latestRecordMetadata.outboundSend.status,
    "failed",
  );
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

test("hosted install start creates a Console pairing without admin auth", async () => {
  const env = fakeEnv("unused-token-hash");
  const response = await relayWorker.fetch(
    new Request("https://relay.example/api/console/install/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.installationId, "string");
  assert.equal(typeof body.consoleToken, "string");
  assert.match(body.next.botOAuthUrl, /\/oauth\/twitch\/start/);
  assert.equal(
    new URL(body.next.botOAuthUrl).searchParams.get("installationId"),
    body.installationId,
  );
  assert.equal(
    body.next.twitchCallbackUrl,
    "https://relay.example/oauth/twitch/callback",
  );
  assert.equal(
    body.next.twitchEventSubWebhookUrl,
    "https://relay.example/webhooks/twitch/eventsub",
  );
  assert.equal(
    body.next.discordInteractionUrl,
    "https://relay.example/webhooks/discord/interactions",
  );
  assert.equal(JSON.stringify(body).includes("actual-secret-value"), false);
  assert.equal(JSON.stringify(body).includes("admin-token"), false);
});

test("console-authenticated Discord config stores operator role", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken));
  const unauthorized = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/discord/config?installationId=installation-1",
      {
        method: "POST",
        body: JSON.stringify({ operatorRoleId: "123456789012345678" }),
      },
    ),
    env,
    fakeExecutionContext(),
  );
  assert.equal(unauthorized.status, 401);

  const response = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/discord/config?installationId=installation-1",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${consoleToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operatorRoleId: "123456789012345678" }),
      },
    ),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.operatorRoleId, "123456789012345678");
});

test("Discord install start requires Console auth and returns an authorize URL", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken));
  const unauthorized = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/discord/install/start?installationId=installation-1",
      { method: "POST", body: "{}" },
    ),
    env,
    fakeExecutionContext(),
  );
  assert.equal(unauthorized.status, 401);

  const response = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/discord/install/start?installationId=installation-1",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${consoleToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;
  const authorizeUrl = new URL(body.authorizeUrl);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(authorizeUrl.hostname, "discord.com");
  assert.equal(
    authorizeUrl.searchParams.get("scope"),
    "bot applications.commands identify",
  );
  assert.equal(
    authorizeUrl.searchParams.get("redirect_uri"),
    "https://relay.example/oauth/discord/callback",
  );
});

test("Discord callback stores selected guild without persisting OAuth tokens", async () => {
  const db = discordInstallCallbackDb();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    if (String(input).includes("/oauth2/token")) {
      return Response.json({
        access_token: "discord-access-token",
        refresh_token: "discord-refresh-token",
        token_type: "Bearer",
        expires_in: 604800,
        scope: "bot applications.commands identify",
        guild: {
          id: "123456789012345678",
          name: "VaexCore Test Server",
        },
      });
    }
    if (String(input).includes("/oauth2/token/revoke")) {
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as typeof fetch;

  try {
    const response = await relayWorker.fetch(
      new Request(
        "https://relay.example/oauth/discord/callback?code=discord-code&state=state-1",
      ),
      discordInstallEnv(db),
      fakeExecutionContext(),
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Discord authorization saved/);
    assert.equal(db.config?.guildId, "123456789012345678");
    assert.equal(db.config?.guildName, "VaexCore Test Server");
    assert.equal(db.deletedState, "state-1");
    assert.equal(
      JSON.stringify(db.config).includes("discord-access-token"),
      false,
    );
    assert.equal(
      fetched.some((url) => url.includes("/oauth2/token/revoke")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord readiness accepts stored guild without DISCORD_GUILD_ID", async () => {
  const consoleToken = "console-token";
  const env = fakeEnv(await sha256Base64Url(consoleToken), {
    discordGuildEnv: null,
    storedDiscordGuild: true,
  });
  const response = await relayWorker.fetch(
    new Request(
      "https://relay.example/api/console/discord/status?installationId=installation-1",
      { headers: { authorization: `Bearer ${consoleToken}` } },
    ),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;
  const guildCheck = body.readiness.checks.find(
    (check: { key: string }) => check.key === "discord-guild-id",
  );

  assert.equal(response.status, 200);
  assert.equal(body.config.guildId, "stored-discord-guild");
  assert.equal(guildCheck.ok, true);
  assert.match(guildCheck.detail, /Discord is connected/);
});

test("stored Discord operator role allows announcement commands", async () => {
  const signing = await discordSigningFixture();
  const db = discordInteractionDb("123456789012345678");
  const env = discordInteractionEnv(signing.publicKeyHex, db, undefined);
  const commands = ["live", "late", "cancelled", "scheduled"];

  for (const command of commands) {
    const response = await relayWorker.fetch(
      await signedDiscordInteractionRequest(signing.privateKey, command, {
        roles: ["123456789012345678"],
      }),
      env,
      fakeExecutionContext(),
    );
    const body = (await response.json()) as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(
      body.data.content,
      "Announcement queued for VaexCore Console review.",
    );
  }

  assert.equal(db.interactions.length, commands.length);
  assert.deepEqual(
    db.interactions.map((interaction) => interaction.commandName),
    commands,
  );
  assert.deepEqual(
    db.interactions.map((interaction) => interaction.status),
    commands.map(() => "queued"),
  );
  assert.equal(
    db.interactions.every((interaction) => interaction.allowed),
    true,
  );
});

test("Discord operator role env fallback still allows announcements", async () => {
  const signing = await discordSigningFixture();
  const db = discordInteractionDb(null);
  const env = discordInteractionEnv(signing.publicKeyHex, db, "env-operator");
  const response = await relayWorker.fetch(
    await signedDiscordInteractionRequest(signing.privateKey, "live", {
      roles: ["env-operator"],
    }),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;

  assert.equal(response.status, 200);
  assert.equal(
    body.data.content,
    "Announcement queued for VaexCore Console review.",
  );
  assert.equal(db.interactions.length, 1);
  const interaction = db.interactions[0];
  assert(interaction);
  assert.equal(interaction.allowed, true);
  assert.equal(interaction.status, "queued");
});
