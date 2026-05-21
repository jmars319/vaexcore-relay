import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test from "node:test";
import relayWorker from "../src/index";
import { sha256Base64Url } from "../src/crypto";

const guildId = "123456789012345678";
const botUserId = "999999999999999999";
const botToken = "discord-token";

test("hosted Discord setup previews, applies, stores IDs, and stays idempotent", async () => {
  const consoleToken = "console-token";
  const db = hostedSetupDb(await sha256Base64Url(consoleToken));
  const fakeDiscord = await startFakeDiscord();
  const env = {
    PUBLIC_BASE_URL: "https://relay.example",
    TWITCH_REDIRECT_URI: "https://relay.example/oauth/twitch/callback",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TWITCH_EVENTSUB_SECRET: "eventsub-secret",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    RELAY_ADMIN_TOKEN: "admin-token",
    DISCORD_BOT_TOKEN: botToken,
    DISCORD_PUBLIC_KEY: "public-key",
    DISCORD_APPLICATION_ID: "discord-app",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    DISCORD_API_BASE_URL: `${fakeDiscord.url}/api/v10`,
    DB: db,
  } as any;
  const auth = {
    authorization: `Bearer ${consoleToken}`,
    "content-type": "application/json",
  };

  try {
    const preview = await relayJson(
      "/api/console/discord/setup/preview?installationId=installation-1",
      env,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          templateId: "full-creator-community",
          includeRoles: true,
          applyPermissions: true,
          postStarterMessages: true,
        }),
      },
    );

    assert.equal(preview.connected, true);
    assert.equal(preview.plan.template.name, "Full Creator Server");
    assert.equal(preview.plan.summary.rolesToCreate >= 13, true);
    assert.equal(preview.plan.summary.starterMessagesToPost >= 8, true);
    assert.equal(
      preview.plan.actions.some(
        (action: Record<string, string>) =>
          action.type === "use_existing_channel" &&
          action.name === "announcements",
      ),
      true,
    );

    const applied = await relayJson(
      "/api/console/discord/setup/apply?installationId=installation-1",
      env,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          templateId: "full-creator-community",
          includeRoles: true,
          applyPermissions: true,
          postStarterMessages: true,
        }),
      },
    );

    assert.equal(applied.ok, true);
    assert.equal(applied.createdRoles.length >= 13, true);
    assert.equal(applied.starterMessagesPosted >= 8, true);
    assert.equal(Boolean(db.config.operatorRoleId), true);
    assert.equal(Boolean(db.config.createdMessageIds.welcome), true);
    const messageCountAfterApply = fakeDiscord.messages.length;

    const idempotent = await relayJson(
      "/api/console/discord/setup/apply?installationId=installation-1",
      env,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          templateId: "full-creator-community",
          includeRoles: true,
          applyPermissions: true,
          postStarterMessages: true,
        }),
      },
    );

    assert.equal(idempotent.createdChannels.length, 0);
    assert.equal(idempotent.createdRoles.length, 0);
    assert.equal(idempotent.starterMessagesPosted, 0);
    assert.equal(fakeDiscord.messages.length, messageCountAfterApply);
  } finally {
    await fakeDiscord.stop();
  }
});

const relayJson = async (path: string, env: any, init: RequestInit) => {
  const response = await relayWorker.fetch(
    new Request(`https://relay.example${path}`, init),
    env,
    fakeExecutionContext(),
  );
  const body = (await response.json()) as Record<string, any>;
  if (!response.ok) {
    throw new Error(
      `${path} failed ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
};

const fakeExecutionContext = () =>
  ({
    waitUntil() {},
    passThroughOnException() {},
  }) as any;

const hostedSetupDb = (consoleTokenHash: string) => {
  const config = {
    guildId,
    guildName: "VaexCore Test Server",
    operatorRoleId: null as string | null,
    setupTemplateId: "full-creator-community",
    setupAppliedAt: null as string | null,
    starterMessagesAppliedAt: null as string | null,
    streamAnnouncementChannelId: null as string | null,
    generalAnnouncementChannelId: null as string | null,
    suggestionChannelId: null as string | null,
    streamAlertsRoleId: null as string | null,
    createdChannelIds: {} as Record<string, string>,
    createdRoleIds: {} as Record<string, string>,
    createdMessageIds: {} as Record<string, string>,
  };
  return {
    get config() {
      return config;
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
              console_token_hash: consoleTokenHash,
              bot_user_id: null,
              bot_login: null,
              broadcaster_user_id: null,
              broadcaster_login: null,
              created_at: "2026-05-21T12:00:00.000Z",
              updated_at: "2026-05-21T12:00:00.000Z",
            } as T;
          }
          if (sql.includes("FROM discord_configs")) {
            return {
              installation_id: "installation-1",
              application_id: "discord-app",
              guild_id: config.guildId,
              guild_name: config.guildName,
              operator_role_id: config.operatorRoleId,
              interaction_url:
                "https://relay.example/webhooks/discord/interactions",
              installed_at: "2026-05-21T12:01:00.000Z",
              setup_template_id: config.setupTemplateId,
              setup_applied_at: config.setupAppliedAt,
              starter_messages_applied_at: config.starterMessagesAppliedAt,
              stream_announcement_channel_id:
                config.streamAnnouncementChannelId,
              general_announcement_channel_id:
                config.generalAnnouncementChannelId,
              suggestion_channel_id: config.suggestionChannelId,
              stream_alerts_role_id: config.streamAlertsRoleId,
              created_channel_ids_json: JSON.stringify(
                config.createdChannelIds,
              ),
              created_role_ids_json: JSON.stringify(config.createdRoleIds),
              created_message_ids_json: JSON.stringify(
                config.createdMessageIds,
              ),
              updated_at: "2026-05-21T12:01:00.000Z",
            } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("UPDATE discord_configs")) {
            config.setupTemplateId = String(this.bindings[0]);
            config.setupAppliedAt = String(this.bindings[1]);
            config.starterMessagesAppliedAt = this.bindings[2] as string | null;
            config.streamAnnouncementChannelId = this.bindings[3] as
              | string
              | null;
            config.generalAnnouncementChannelId = this.bindings[4] as
              | string
              | null;
            config.suggestionChannelId = this.bindings[5] as string | null;
            config.streamAlertsRoleId = this.bindings[6] as string | null;
            config.operatorRoleId = this.bindings[7] as string | null;
            config.createdChannelIds = JSON.parse(String(this.bindings[8]));
            config.createdRoleIds = JSON.parse(String(this.bindings[9]));
            config.createdMessageIds = JSON.parse(String(this.bindings[10]));
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

async function startFakeDiscord() {
  const state = {
    nextId: 200000000000000000n,
    channels: [
      {
        id: "111111111111111111",
        name: "rules",
        type: 0,
        parent_id: null,
        topic: null,
        position: 0,
      },
      {
        id: "111111111111111112",
        name: "announcements",
        type: 5,
        parent_id: null,
        topic: null,
        position: 1,
      },
    ],
    roles: [
      { id: guildId, name: "@everyone", managed: false },
      { id: botUserId, name: "VaexCore", managed: true },
    ],
    messages: [] as Array<{ id: string; content: string }>,
    permissionOverwrites: [] as Array<{ path: string; body: unknown }>,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    if (request.headers.authorization !== `Bot ${botToken}`) {
      send(response, 401, { message: "Unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {
      send(response, 200, {
        id: botUserId,
        username: "VaexCoreBot",
        discriminator: "0000",
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/api/v10/guilds/${guildId}/channels`
    ) {
      send(response, 200, state.channels);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/api/v10/guilds/${guildId}/roles`
    ) {
      send(response, 200, state.roles);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === `/api/v10/guilds/${guildId}/roles`
    ) {
      const body = await readBody(request);
      const role = {
        id: nextId(state),
        name: body.name,
        permissions: body.permissions ?? "0",
        color: body.color ?? 0,
        hoist: Boolean(body.hoist),
        managed: false,
        mentionable: Boolean(body.mentionable),
      };
      state.roles.push(role);
      send(response, 200, role);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === `/api/v10/guilds/${guildId}/channels`
    ) {
      const body = await readBody(request);
      const channel = {
        id: nextId(state),
        name: body.name,
        type: body.type,
        parent_id: body.parent_id ?? null,
        topic: body.topic ?? null,
        position: state.channels.length,
      };
      state.channels.push(channel);
      send(response, 200, channel);
      return;
    }

    if (
      request.method === "PUT" &&
      /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
    ) {
      const body = await readBody(request);
      const existingIndex = state.permissionOverwrites.findIndex(
        (item) => item.path === url.pathname,
      );
      const overwrite = { path: url.pathname, body };
      if (existingIndex >= 0) {
        state.permissionOverwrites[existingIndex] = overwrite;
      } else {
        state.permissionOverwrites.push(overwrite);
      }
      send(response, 204, {});
      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/v10\/channels\/\d+\/messages$/.test(url.pathname)
    ) {
      const body = await readBody(request);
      const message = {
        id: nextId(state),
        content: body.content ?? "",
      };
      state.messages.push(message);
      send(response, 200, message);
      return;
    }

    send(response, 404, {
      message: `Unhandled ${request.method} ${url.pathname}`,
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Discord server did not bind.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    get messages() {
      return state.messages;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function nextId(state: { nextId: bigint }) {
  state.nextId += 1n;
  return state.nextId.toString();
}

async function readBody(request: IncomingMessage) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
