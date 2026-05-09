import { constantTimeEqual, randomToken, sha256Base64Url } from "./crypto";
import {
  accessTokenFromGrant,
  buildTwitchAuthorizeUrl,
  createChatMessageSubscription,
  encryptedGrantFromToken,
  exchangeTwitchCode,
  getAppAccessToken,
  missingScopes,
  normalizeChatEvent,
  scopesForGrant,
  sendAppTokenChatMessage,
  validateTwitchToken,
  verifyEventSubSignature,
} from "./twitch";
import {
  type InstallationRow,
  type OAuthGrantKind,
  type OAuthGrantRow,
  type RelayReadiness,
  type TwitchEventSubEnvelope,
  requiredBotScopes,
  requiredBroadcasterScopes,
} from "./types";

const serviceName = "vaexcore relay";
const serviceVersion = "0.1.0";
const maxJsonBytes = 64 * 1024;

type RelayEnv = Env & {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_EVENTSUB_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  RELAY_ADMIN_TOKEN: string;
};

export default {
  async fetch(
    request: Request,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          service: serviceName,
          version: serviceVersion,
          capabilities: [
            "twitch.chatbot-identity",
            "twitch.eventsub.webhooks",
            "twitch.app-token-chat",
          ],
        });
      }
      if (request.method === "GET" && url.pathname === "/diagnostics") {
        await requireAdmin(request, env);
        return json({
          ok: true,
          service: serviceName,
          version: serviceVersion,
          publicBaseUrl: env.PUBLIC_BASE_URL,
          hasTwitchClientId: Boolean(env.TWITCH_CLIENT_ID),
          hasEventSubSecret: Boolean(env.TWITCH_EVENTSUB_SECRET),
          hasEncryptionKey: Boolean(env.TOKEN_ENCRYPTION_KEY),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/console/pair") {
        await requireAdmin(request, env);
        return pairConsole(await readJson(request), env);
      }
      if (request.method === "GET" && url.pathname === "/api/console/status") {
        const installation = await requireConsole(request, env, url);
        return json({
          ok: true,
          installation: safeInstallation(installation),
          readiness: await getReadiness(env, installation.id),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/console/events") {
        const installation = await requireConsole(request, env, url);
        return getQueuedEvents(
          env,
          installation.id,
          Number(url.searchParams.get("limit") ?? "25"),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/eventsub/register"
      ) {
        const installation = await requireConsole(request, env, url);
        return registerEventSub(env, installation.id, ctx);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/chat/send"
      ) {
        const installation = await requireConsole(request, env, url);
        return sendChat(await readJson(request), env, installation.id);
      }
      if (request.method === "GET" && url.pathname === "/oauth/twitch/start") {
        return startOAuth(url, env);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/oauth/twitch/callback"
      ) {
        return finishOAuth(url, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/webhooks/twitch/eventsub"
      ) {
        return handleEventSubWebhook(request, env, ctx);
      }
      return json({ ok: false, error: "Not found" }, { status: 404 });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error instanceof Error ? error.message : "Relay request failed",
        },
        { status: error instanceof HttpError ? error.status : 500 },
      );
    }
  },
};

const pairConsole = async (body: unknown, env: RelayEnv) => {
  const input = objectInput(body);
  const name =
    stringInput(input.name, "Installation name", 80) || "VaexCore Console";
  const id = crypto.randomUUID();
  const consoleToken = randomToken(32);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO installations (
        id, name, console_token_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(id, name, await sha256Base64Url(consoleToken), now, now)
    .run();
  await writeAudit(env, id, "installation.create", id, { name });
  return json({
    ok: true,
    installationId: id,
    consoleToken,
    next: {
      botOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=bot`,
      broadcasterOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=broadcaster`,
    },
  });
};

const startOAuth = async (url: URL, env: RelayEnv) => {
  const installationId = stringInput(
    url.searchParams.get("installationId"),
    "Installation ID",
    80,
  );
  const kind = grantKind(url.searchParams.get("kind"));
  const installation = await getInstallation(env, installationId);
  if (!installation) {
    throw new HttpError(404, "Installation was not found.");
  }
  const state = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `
      INSERT INTO oauth_states (
        state, installation_id, grant_kind, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(state, installationId, kind, now.toISOString(), expiresAt)
    .run();
  return Response.redirect(
    buildTwitchAuthorizeUrl({
      clientId: env.TWITCH_CLIENT_ID,
      redirectUri: env.TWITCH_REDIRECT_URI,
      state,
      kind,
    }),
    302,
  );
};

const finishOAuth = async (url: URL, env: RelayEnv) => {
  const code = stringInput(url.searchParams.get("code"), "OAuth code", 400);
  const state = stringInput(url.searchParams.get("state"), "OAuth state", 120);
  const stateRow = await env.DB.prepare(
    `
      SELECT state, installation_id, grant_kind, expires_at
      FROM oauth_states
      WHERE state = ?
    `,
  )
    .bind(state)
    .first<{
      installation_id: string;
      grant_kind: OAuthGrantKind;
      expires_at: string;
    }>();
  if (!stateRow || Date.parse(stateRow.expires_at) < Date.now()) {
    throw new HttpError(400, "OAuth state is missing or expired.");
  }
  const token = await exchangeTwitchCode({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    redirectUri: env.TWITCH_REDIRECT_URI,
    code,
  });
  const validation = await validateTwitchToken(token.access_token);
  const required = scopesForGrant(stateRow.grant_kind);
  const missing = missingScopes(validation.scopes, required);
  if (missing.length > 0) {
    throw new HttpError(
      403,
      `Twitch grant is missing required scope(s): ${missing.join(", ")}`,
    );
  }
  const grant = await encryptedGrantFromToken({
    installationId: stateRow.installation_id,
    kind: stateRow.grant_kind,
    token,
    validation,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  });
  await env.DB.prepare(
    `
      INSERT INTO oauth_grants (
        installation_id, grant_kind, user_id, login, scopes_json,
        encrypted_access_token, encrypted_refresh_token, token_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, grant_kind) DO UPDATE SET
        user_id = excluded.user_id,
        login = excluded.login,
        scopes_json = excluded.scopes_json,
        encrypted_access_token = excluded.encrypted_access_token,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        token_expires_at = excluded.token_expires_at,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      grant.installation_id,
      grant.grant_kind,
      grant.user_id,
      grant.login,
      grant.scopes_json,
      grant.encrypted_access_token,
      grant.encrypted_refresh_token,
      grant.token_expires_at,
      grant.updated_at,
    )
    .run();
  const columnPrefix = stateRow.grant_kind === "bot" ? "bot" : "broadcaster";
  await env.DB.prepare(
    `
      UPDATE installations
      SET ${columnPrefix}_user_id = ?, ${columnPrefix}_login = ?, updated_at = ?
      WHERE id = ?
    `,
  )
    .bind(
      validation.user_id,
      validation.login,
      new Date().toISOString(),
      stateRow.installation_id,
    )
    .run();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?")
    .bind(state)
    .run();
  await writeAudit(
    env,
    stateRow.installation_id,
    `oauth.${stateRow.grant_kind}.connected`,
    validation.user_id,
    {
      login: validation.login,
      scopes: validation.scopes,
    },
  );
  return html(
    "Twitch authorization saved. You can close this tab and return to vaexcore console.",
  );
};

const registerEventSub = async (
  env: RelayEnv,
  installationId: string,
  ctx: ExecutionContext,
) => {
  const { installation, botGrant, broadcasterGrant } =
    await requireRelayReadyGrants(env, installationId);
  const appToken = await getAppAccessToken({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
  });
  const result = await createChatMessageSubscription({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken: appToken.access_token,
    broadcasterId: broadcasterGrant.user_id,
    userId: botGrant.user_id,
    callbackUrl: `${env.PUBLIC_BASE_URL}/webhooks/twitch/eventsub`,
    secret: env.TWITCH_EVENTSUB_SECRET,
  });
  const subscription = getFirstDataItem(result.body);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO eventsub_subscriptions (
        id, installation_id, twitch_subscription_id, type, version, status,
        condition_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installation.id,
      stringFrom(subscription?.id),
      "channel.chat.message",
      "1",
      result.response.ok ? "created" : "failed",
      JSON.stringify({
        broadcaster_user_id: broadcasterGrant.user_id,
        user_id: botGrant.user_id,
      }),
      now,
      now,
    )
    .run();
  ctx.waitUntil(
    writeAudit(
      env,
      installationId,
      "eventsub.chat.register",
      stringFrom(subscription?.id),
      {
        ok: result.response.ok,
        status: result.response.status,
      },
    ),
  );
  if (!result.response.ok) {
    throw new HttpError(
      result.response.status,
      "Twitch rejected EventSub registration.",
    );
  }
  return json({ ok: true, subscription });
};

const handleEventSubWebhook = async (
  request: Request,
  env: RelayEnv,
  ctx: ExecutionContext,
) => {
  const body = await readBoundedText(request, maxJsonBytes);
  const messageId = headerValue(request, "Twitch-Eventsub-Message-Id");
  const timestamp = headerValue(request, "Twitch-Eventsub-Message-Timestamp");
  const signature = headerValue(request, "Twitch-Eventsub-Message-Signature");
  const verified = await verifyEventSubSignature({
    messageId,
    timestamp,
    body,
    secret: env.TWITCH_EVENTSUB_SECRET,
    signature,
  });
  if (!verified) {
    throw new HttpError(403, "EventSub signature verification failed.");
  }
  const envelope = JSON.parse(body) as TwitchEventSubEnvelope;
  if (envelope.metadata?.message_type === "webhook_callback_verification") {
    return new Response(envelope.payload?.challenge ?? "", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const event = normalizeChatEvent(envelope);
  if (event) {
    const installation = await findInstallationForBroadcaster(
      env,
      event.broadcasterUserId,
    );
    if (installation) {
      await env.DB.prepare(
        `
          INSERT OR IGNORE INTO chat_events (
            id, installation_id, twitch_message_id, event_json, received_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
        .bind(
          crypto.randomUUID(),
          installation.id,
          event.id,
          JSON.stringify(event),
          event.receivedAt,
        )
        .run();
      ctx.waitUntil(
        writeAudit(env, installation.id, "eventsub.chat.message", event.id, {
          userLogin: event.userLogin,
        }),
      );
    }
  }
  return json({ ok: true });
};

const getQueuedEvents = async (
  env: RelayEnv,
  installationId: string,
  limit: number,
) => {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 100)
    : 25;
  const rows = await env.DB.prepare(
    `
      SELECT id, event_json
      FROM chat_events
      WHERE installation_id = ? AND delivered_at IS NULL
      ORDER BY received_at ASC
      LIMIT ?
    `,
  )
    .bind(installationId, safeLimit)
    .all<{ id: string; event_json: string }>();
  const events = rows.results.map((row) => ({
    relayEventId: row.id,
    ...JSON.parse(row.event_json),
  }));
  if (events.length > 0) {
    const now = new Date().toISOString();
    const statements = rows.results.map((row) =>
      env.DB.prepare(
        "UPDATE chat_events SET delivered_at = ? WHERE id = ?",
      ).bind(now, row.id),
    );
    await env.DB.batch(statements);
  }
  return json({ ok: true, events });
};

const sendChat = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const message = stringInput(input.message, "Chat message", 500);
  const { botGrant, broadcasterGrant } = await requireRelayReadyGrants(
    env,
    installationId,
  );
  await accessTokenFromGrant(botGrant, env.TOKEN_ENCRYPTION_KEY);
  const appToken = await getAppAccessToken({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
  });
  const result = await sendAppTokenChatMessage({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken: appToken.access_token,
    broadcasterId: broadcasterGrant.user_id,
    senderId: botGrant.user_id,
    message,
  });
  const data = getFirstDataItem(result.body);
  const dropReason = data?.drop_reason ? JSON.stringify(data.drop_reason) : "";
  const sent = result.response.ok && data?.is_sent !== false;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO outbound_chat_sends (
        id, installation_id, broadcaster_user_id, sender_user_id, message,
        status, twitch_message_id, failure_category, reason, retry_after_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      broadcasterGrant.user_id,
      botGrant.user_id,
      message,
      sent ? "sent" : "failed",
      stringFrom(data?.message_id),
      sent ? null : "twitch_rejected",
      sent ? null : dropReason || `Twitch response ${result.response.status}`,
      retryAfterMs(result.response),
      now,
      now,
    )
    .run();
  await writeAudit(
    env,
    installationId,
    "chat.send",
    stringFrom(data?.message_id),
    {
      ok: sent,
      status: result.response.status,
    },
  );
  if (!sent) {
    throw new HttpError(
      result.response.ok ? 502 : result.response.status,
      "Twitch did not send the chat message.",
    );
  }
  return json({
    ok: true,
    messageId: stringFrom(data?.message_id),
    transport: "relay-chatbot",
  });
};

const getReadiness = async (
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
  const checks = [
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
      ok:
        Boolean(botGrant?.user_id && broadcasterGrant?.user_id) &&
        botGrant?.user_id !== broadcasterGrant?.user_id,
      detail:
        botGrant &&
        broadcasterGrant &&
        botGrant.user_id === broadcasterGrant.user_id
          ? "Twitch will not show the broadcaster account as a chatbot."
          : "Bot and broadcaster accounts are separate.",
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    mode: "relay-chatbot",
    checks,
  };
};

const requireRelayReadyGrants = async (
  env: RelayEnv,
  installationId: string,
) => {
  const [installation, botGrant, broadcasterGrant] = await Promise.all([
    getInstallation(env, installationId),
    getGrant(env, installationId, "bot"),
    getGrant(env, installationId, "broadcaster"),
  ]);
  if (!installation || !botGrant || !broadcasterGrant) {
    throw new HttpError(
      409,
      "Relay is missing bot or broadcaster Twitch authorization.",
    );
  }
  if (botGrant.user_id === broadcasterGrant.user_id) {
    throw new HttpError(
      409,
      "Bot account must be separate from the broadcaster account for Twitch chatbot identity.",
    );
  }
  return { installation, botGrant, broadcasterGrant };
};

const requireAdmin = async (request: Request, env: RelayEnv) => {
  const token = bearerToken(request);
  if (
    !env.RELAY_ADMIN_TOKEN ||
    !token ||
    !constantTimeEqual(token, env.RELAY_ADMIN_TOKEN)
  ) {
    throw new HttpError(401, "Relay admin authorization is required.");
  }
};

const requireConsole = async (request: Request, env: RelayEnv, url: URL) => {
  const installationId = stringInput(
    url.searchParams.get("installationId"),
    "Installation ID",
    80,
  );
  const installation = await getInstallation(env, installationId);
  if (!installation) {
    throw new HttpError(404, "Installation was not found.");
  }
  const token = bearerToken(request);
  const tokenHash = token ? await sha256Base64Url(token) : "";
  if (
    !token ||
    !constantTimeEqual(tokenHash, installation.console_token_hash)
  ) {
    throw new HttpError(401, "Console authorization is required.");
  }
  return installation;
};

const getInstallation = (env: RelayEnv, id: string) =>
  env.DB.prepare("SELECT * FROM installations WHERE id = ?")
    .bind(id)
    .first<InstallationRow>();

const findInstallationForBroadcaster = (
  env: RelayEnv,
  broadcasterUserId: string,
) =>
  env.DB.prepare("SELECT * FROM installations WHERE broadcaster_user_id = ?")
    .bind(broadcasterUserId)
    .first<InstallationRow>();

const getGrant = (
  env: RelayEnv,
  installationId: string,
  kind: OAuthGrantKind,
) =>
  env.DB.prepare(
    "SELECT * FROM oauth_grants WHERE installation_id = ? AND grant_kind = ?",
  )
    .bind(installationId, kind)
    .first<OAuthGrantRow>();

const safeInstallation = (installation: InstallationRow) => ({
  id: installation.id,
  name: installation.name,
  botLogin: installation.bot_login ?? "",
  broadcasterLogin: installation.broadcaster_login ?? "",
  createdAt: installation.created_at,
  updatedAt: installation.updated_at,
});

const writeAudit = async (
  env: RelayEnv,
  installationId: string | null,
  action: string,
  target: string | null,
  metadata: Record<string, unknown>,
) =>
  env.DB.prepare(
    `
      INSERT INTO audit_events (
        id, installation_id, action, target, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      action,
      target,
      JSON.stringify(redact(metadata)),
      new Date().toISOString(),
    )
    .run();

export const readBoundedText = async (request: Request, maxBytes: number) => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  return text;
};

const readJson = async (request: Request) =>
  JSON.parse(await readBoundedText(request, maxJsonBytes));

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });

const html = (body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>VaexCore Relay</title><p>${escapeHtml(body)}</p>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );

const objectInput = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
};

const stringInput = (value: unknown, field: string, maxLength: number) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} is too long.`);
  }
  return trimmed;
};

const grantKind = (value: unknown): OAuthGrantKind => {
  if (value === "bot" || value === "broadcaster") return value;
  throw new HttpError(400, "OAuth grant kind must be bot or broadcaster.");
};

const bearerToken = (request: Request) => {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
};

const headerValue = (request: Request, name: string) => {
  const value = request.headers.get(name);
  if (!value) {
    throw new HttpError(400, `${name} header is required.`);
  }
  return value;
};

const getFirstDataItem = (body: unknown): Record<string, unknown> | null => {
  if (
    body &&
    typeof body === "object" &&
    "data" in body &&
    Array.isArray(body.data)
  ) {
    return (body.data[0] as Record<string, unknown> | undefined) ?? null;
  }
  return null;
};

const stringFrom = (value: unknown) =>
  typeof value === "string" ? value : null;

const retryAfterMs = (response: Response) => {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

const redact = (value: unknown): unknown => {
  if (typeof value === "string") {
    return /token|secret|authorization|oauth/i.test(value)
      ? "[redacted]"
      : value.slice(0, 500);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|authorization|oauth/i.test(key)
          ? "[redacted]"
          : redact(item),
      ]),
    );
  }
  return value;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
