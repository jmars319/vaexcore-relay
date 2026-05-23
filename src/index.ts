import {
  constantTimeEqual,
  isValidEncryptionKey,
  randomToken,
  sha256Base64Url,
} from "./crypto";
import {
  type DiscordInteraction,
  buildDiscordInstallAuthorizeUrl,
  discordApplicationCommands,
  discordCommandKind,
  discordEphemeralResponse,
  discordInteractionMatchesConfiguredGuild,
  discordInteractionResponseType,
  discordInteractionType,
  discordInteractionUser,
  discordOptionRecord,
  discordOptionString,
  discordHostedInstallPermissions,
  exchangeDiscordOAuthCode,
  hasDiscordOperatorPermission,
  isDiscordAnnouncementCommand,
  registerDiscordApplicationCommands,
  revokeDiscordOAuthToken,
  verifyDiscordInteractionSignature,
} from "./discord";
import { SafeInputError } from "../../console/desktop/shared/src/core/security";
import { DiscordApiClient } from "../../console/desktop/shared/src/discord/client";
import {
  applyDiscordServerSetup,
  planDiscordServerSetup,
} from "../../console/desktop/shared/src/discord/setup";
import {
  discordSetupTemplates,
  getDiscordSetupTemplate,
} from "../../console/desktop/shared/src/discord/templates";
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
  type DiscordCommandRegistrationRow,
  type DiscordInteractionRow,
  type DiscordReadiness,
  type DiscordSuggestionRow,
  type DiscordSuggestionStatus,
  type InstallationRow,
  type OAuthGrantKind,
  type OAuthGrantRow,
  type OutboundChatSendRow,
  type RelayBotReadinessReport,
  type RelayFreshness,
  type RelayQueueHealth,
  type RelayReadiness,
  type RelaySchemaReadiness,
  type TwitchEventSubEnvelope,
  requiredBotScopes,
  requiredBroadcasterScopes,
} from "./types";

const serviceName = "vaexcore relay";
const serviceVersion = "0.1.0";
const maxJsonBytes = 64 * 1024;
const maxOutboundRetryAttempts = 3;
const outboundRetryBatchLimit = 25;
const defaultRetryBackoffMs = 60_000;
const hostedDiscordSetupMutationLimit = 15;

type RelayEnv = Env & {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_EVENTSUB_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  RELAY_ADMIN_TOKEN: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_OPERATOR_ROLE_ID?: string;
  DISCORD_API_BASE_URL?: string;
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
            "discord.interactions-webhook",
            "discord.suggestion-queue",
            "discord.command-registration",
          ],
        });
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/diagnostics" ||
          url.pathname === "/admin/diagnostics")
      ) {
        await requireAdmin(request, env);
        return json(await getAdminDiagnostics(env));
      }
      if (request.method === "POST" && url.pathname === "/api/console/pair") {
        await requireAdmin(request, env);
        return pairConsole(await readJson(request), env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/install/start"
      ) {
        return startConsoleInstall(await readJson(request), env);
      }
      if (request.method === "GET" && url.pathname === "/api/console/status") {
        const installation = await requireConsole(request, env, url);
        const [readiness, schema, queues, freshness, latest] =
          await Promise.all([
            getReadiness(env, installation.id),
            getSchemaReadiness(env),
            getQueueHealth(env, installation.id),
            getFreshness(env, installation.id),
            getLatestReadinessRecords(env, installation.id),
          ]);
        return json({
          ok: true,
          installation: safeInstallation(installation),
          readiness,
          schema,
          queues,
          freshness,
          latestRecordMetadata: latestRecordMetadata(latest),
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/console/readiness-report"
      ) {
        const installation = await requireConsole(request, env, url);
        return json(await getBotReadinessReport(env, installation));
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/console/discord/status"
      ) {
        const installation = await requireConsole(request, env, url);
        return json({
          ok: true,
          readiness: await getDiscordReadiness(env, installation.id),
          config: await getSafeHostedDiscordConfig(env, installation.id),
          templates: discordSetupTemplates.map(safeDiscordTemplateSummary),
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/install/start"
      ) {
        const installation = await requireConsole(request, env, url);
        return startDiscordInstall(
          await readJson(request),
          env,
          installation.id,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/config"
      ) {
        const installation = await requireConsole(request, env, url);
        return updateDiscordConfig(
          await readJson(request),
          env,
          installation.id,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/setup/preview"
      ) {
        const installation = await requireConsole(request, env, url);
        return await previewHostedDiscordSetup(
          await readJson(request),
          env,
          installation.id,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/setup/apply"
      ) {
        const installation = await requireConsole(request, env, url);
        return await applyHostedDiscordSetup(
          await readJson(request),
          env,
          installation.id,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/commands/register"
      ) {
        const installation = await requireConsole(request, env, url);
        return registerDiscordCommands(env, installation.id, ctx);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/console/discord/events"
      ) {
        const installation = await requireConsole(request, env, url);
        return getQueuedDiscordEvents(
          env,
          installation.id,
          Number(url.searchParams.get("limit") ?? "25"),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/console/discord/suggestions"
      ) {
        const installation = await requireConsole(request, env, url);
        return getDiscordSuggestions(
          env,
          installation.id,
          url.searchParams.get("status"),
          Number(url.searchParams.get("limit") ?? "50"),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/console/discord/suggestions/status"
      ) {
        const installation = await requireConsole(request, env, url);
        return updateDiscordSuggestionStatus(
          await readJson(request),
          env,
          installation.id,
        );
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
        return finishOAuth(url, env, ctx);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/oauth/discord/callback"
      ) {
        return finishDiscordInstall(url, env, ctx);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/webhooks/twitch/eventsub"
      ) {
        return handleEventSubWebhook(request, env, ctx);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/webhooks/discord/interactions"
      ) {
        return handleDiscordInteractionWebhook(request, env, url, ctx);
      }
      return json({ ok: false, error: "Not found" }, { status: 404 });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error instanceof Error ? error.message : "Relay request failed",
        },
        {
          status:
            error instanceof HttpError
              ? error.status
              : error instanceof SafeInputError
                ? 400
                : 500,
        },
      );
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(processOutboundRetryQueue(env));
  },
};

const pairConsole = async (body: unknown, env: RelayEnv) => {
  const input = objectInput(body);
  const name =
    optionalBoundedString(input.name, "Installation name", 80) ||
    "VaexCore Console";
  return createConsoleInstallation(env, name);
};

const startConsoleInstall = async (body: unknown, env: RelayEnv) => {
  const input = objectInput(body);
  const name =
    optionalBoundedString(input.name, "Installation name", 80) ||
    "VaexCore Console";
  return createConsoleInstallation(env, name);
};

const createConsoleInstallation = async (env: RelayEnv, name: string) => {
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
      twitchCallbackUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/callback`,
      botOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=bot`,
      broadcasterOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=broadcaster`,
      twitchEventSubWebhookUrl: `${env.PUBLIC_BASE_URL}/webhooks/twitch/eventsub`,
      discordInteractionUrl: `${env.PUBLIC_BASE_URL}/webhooks/discord/interactions`,
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

const finishOAuth = async (url: URL, env: RelayEnv, ctx: ExecutionContext) => {
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
  const eventSub = await maybeRegisterEventSubAfterOAuth(
    env,
    stateRow.installation_id,
    ctx,
  );
  const eventSubMessage =
    eventSub.status === "registered"
      ? " EventSub was registered automatically."
      : eventSub.status === "already-registered"
        ? " EventSub was already registered."
        : eventSub.status === "pending"
          ? " Finish the other Twitch authorization in Console to enable automatic EventSub registration."
          : ` EventSub still needs attention: ${eventSub.message}`;
  return html(
    `Twitch authorization saved.${eventSubMessage} You can close this tab and return to vaexcore console.`,
  );
};

const maybeRegisterEventSubAfterOAuth = async (
  env: RelayEnv,
  installationId: string,
  ctx: ExecutionContext,
): Promise<
  | { status: "registered" }
  | { status: "already-registered" }
  | { status: "pending" }
  | { status: "failed"; message: string }
> => {
  if (await hasCreatedEventSubRegistration(env, installationId)) {
    return { status: "already-registered" };
  }

  try {
    await requireRelayReadyGrants(env, installationId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      if (error.message.includes("separate")) {
        return { status: "failed", message: error.message };
      }
      return { status: "pending" };
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    };
  }

  try {
    await registerEventSub(env, installationId, ctx);
    return { status: "registered" };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
};

const hasCreatedEventSubRegistration = async (
  env: RelayEnv,
  installationId: string,
) => {
  const existing = await env.DB.prepare(
    `
      SELECT id
      FROM eventsub_subscriptions
      WHERE installation_id = ?
        AND type = 'channel.chat.message'
        AND status = 'created'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  )
    .bind(installationId)
    .first<{ id: string }>();
  return Boolean(existing);
};

type DiscordConfigRow = {
  installation_id: string;
  application_id: string | null;
  guild_id: string | null;
  guild_name?: string | null;
  operator_role_id: string | null;
  interaction_url: string;
  installed_at?: string | null;
  setup_template_id?: string | null;
  setup_applied_at?: string | null;
  starter_messages_applied_at?: string | null;
  stream_announcement_channel_id?: string | null;
  general_announcement_channel_id?: string | null;
  suggestion_channel_id?: string | null;
  stream_alerts_role_id?: string | null;
  created_channel_ids_json?: string | null;
  created_role_ids_json?: string | null;
  created_message_ids_json?: string | null;
  updated_at: string;
};

const startDiscordInstall = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const applicationId = requiredEnv(
    env.DISCORD_APPLICATION_ID,
    "DISCORD_APPLICATION_ID",
  );
  requiredEnv(env.DISCORD_CLIENT_SECRET, "DISCORD_CLIENT_SECRET");
  requiredEnv(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN");
  const returnUrl = optionalBoundedString(input.returnUrl, "Return URL", 300);
  const state = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "DELETE FROM discord_install_states WHERE expires_at < ?",
  )
    .bind(now.toISOString())
    .run();
  await env.DB.prepare(
    `
      INSERT INTO discord_install_states (
        state, installation_id, return_url, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(state, installationId, returnUrl, now.toISOString(), expiresAt)
    .run();
  const authorizeUrl = buildDiscordInstallAuthorizeUrl({
    applicationId,
    redirectUri: discordRedirectUri(env),
    state,
  });
  await writeAudit(env, installationId, "discord.install.start", null, {
    permissions: discordHostedInstallPermissions(),
  });
  return json({
    ok: true,
    authorizeUrl,
    expiresAt,
    permissions: discordHostedInstallPermissions(),
    redirectUri: discordRedirectUri(env),
  });
};

const finishDiscordInstall = async (
  url: URL,
  env: RelayEnv,
  ctx: ExecutionContext,
) => {
  const denied = url.searchParams.get("error");
  if (denied) {
    throw new HttpError(
      400,
      `Discord authorization was not completed: ${denied}`,
    );
  }
  const code = stringInput(
    url.searchParams.get("code"),
    "Discord OAuth code",
    400,
  );
  const state = stringInput(
    url.searchParams.get("state"),
    "Discord OAuth state",
    120,
  );
  const stateRow = await env.DB.prepare(
    `
      SELECT state, installation_id, return_url, expires_at
      FROM discord_install_states
      WHERE state = ?
    `,
  )
    .bind(state)
    .first<{
      installation_id: string;
      return_url: string | null;
      expires_at: string;
    }>();
  if (!stateRow || Date.parse(stateRow.expires_at) < Date.now()) {
    throw new HttpError(400, "Discord install state is missing or expired.");
  }

  const applicationId = requiredEnv(
    env.DISCORD_APPLICATION_ID,
    "DISCORD_APPLICATION_ID",
  );
  const clientSecret = requiredEnv(
    env.DISCORD_CLIENT_SECRET,
    "DISCORD_CLIENT_SECRET",
  );
  const result = await exchangeDiscordOAuthCode({
    applicationId,
    clientSecret,
    redirectUri: discordRedirectUri(env),
    code,
  });
  if (!result.response.ok || !result.token?.access_token) {
    throw new HttpError(
      result.response.status,
      "Discord rejected the install authorization code.",
    );
  }

  const guildId =
    result.token.guild?.id ?? stringFrom(url.searchParams.get("guild_id"));
  if (!guildId || !/^\d{5,32}$/.test(guildId)) {
    throw new HttpError(
      400,
      "Discord did not return a server ID for this install.",
    );
  }
  const guildName = result.token.guild?.name?.slice(0, 120) ?? null;
  const now = new Date().toISOString();
  await storeDiscordInstall(env, {
    installationId: stateRow.installation_id,
    applicationId,
    guildId,
    guildName,
    installedAt: now,
  });
  await env.DB.prepare("DELETE FROM discord_install_states WHERE state = ?")
    .bind(state)
    .run();

  ctx.waitUntil(
    revokeDiscordOAuthToken({
      applicationId,
      clientSecret,
      token: result.token.access_token,
    }).catch(() => undefined),
  );
  if (result.token.refresh_token) {
    ctx.waitUntil(
      revokeDiscordOAuthToken({
        applicationId,
        clientSecret,
        token: result.token.refresh_token,
      }).catch(() => undefined),
    );
  }
  ctx.waitUntil(
    writeAudit(
      env,
      stateRow.installation_id,
      "discord.install.connected",
      guildId,
      { guildName },
    ),
  );
  return html(
    "Discord authorization saved. You can close this tab and return to vaexcore console.",
  );
};

const previewHostedDiscordSetup = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const config = await requireHostedDiscordGuild(env, installationId);
  const setup = hostedDiscordSetupOptions(input, config);
  const client = createHostedDiscordClient(env);
  const [existingChannels, existingRoles] = await Promise.all([
    client.listGuildChannels(setup.guildId),
    client.listGuildRoles(setup.guildId),
  ]);
  return json({
    ok: true,
    connected: true,
    config: await getSafeHostedDiscordConfig(env, installationId, config),
    plan: planDiscordServerSetup({
      existingChannels,
      existingRoles,
      template: setup.template,
      includeRoles: setup.includeRoles,
      applyPermissions: setup.applyPermissions,
      postStarterMessages: setup.postStarterMessages,
      existingMessageIds: setup.existingMessageIds,
      guildId: setup.guildId,
    }),
    template: setup.template,
  });
};

const applyHostedDiscordSetup = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const config = await requireHostedDiscordGuild(env, installationId);
  const setup = hostedDiscordSetupOptions(input, config);
  const client = createHostedDiscordClient(env);
  const bot = await client.getCurrentUser();
  const result = await applyDiscordServerSetup({
    client,
    guildId: setup.guildId,
    template: setup.template,
    includeRoles: setup.includeRoles,
    applyPermissions: setup.applyPermissions,
    postStarterMessages: setup.postStarterMessages,
    existingMessageIds: setup.existingMessageIds,
    botUserId: bot.id,
    maxMutations: hostedDiscordSetupMutationLimit,
  });
  const createdChannelIds = {
    ...jsonRecord(config.created_channel_ids_json),
    ...result.channelIds,
  };
  const createdRoleIds = {
    ...jsonRecord(config.created_role_ids_json),
    ...result.roleIds,
  };
  const createdMessageIds = {
    ...jsonRecord(config.created_message_ids_json),
    ...result.createdMessageIds,
  };
  const starterMessagesAppliedAt =
    result.starterMessagesPosted > 0
      ? result.appliedAt
      : (config.starter_messages_applied_at ?? null);
  const operatorRoleId =
    result.recommended.operatorRoleId ??
    config.operator_role_id ??
    env.DISCORD_OPERATOR_ROLE_ID ??
    null;
  const setupAppliedAt = result.needsContinuation
    ? (config.setup_applied_at ?? null)
    : result.appliedAt;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      UPDATE discord_configs
      SET setup_template_id = ?,
        setup_applied_at = ?,
        starter_messages_applied_at = ?,
        stream_announcement_channel_id = ?,
        general_announcement_channel_id = ?,
        suggestion_channel_id = ?,
        stream_alerts_role_id = ?,
        operator_role_id = ?,
        created_channel_ids_json = ?,
        created_role_ids_json = ?,
        created_message_ids_json = ?,
        updated_at = ?
      WHERE installation_id = ?
    `,
  )
    .bind(
      setup.template.id,
      setupAppliedAt,
      starterMessagesAppliedAt,
      result.recommended.streamAnnouncementChannelId ??
        config.stream_announcement_channel_id ??
        null,
      result.recommended.generalAnnouncementChannelId ??
        config.general_announcement_channel_id ??
        null,
      result.recommended.suggestionChannelId ??
        config.suggestion_channel_id ??
        null,
      result.recommended.streamAlertsRoleId ??
        config.stream_alerts_role_id ??
        null,
      operatorRoleId,
      JSON.stringify(createdChannelIds),
      JSON.stringify(createdRoleIds),
      JSON.stringify(createdMessageIds),
      now,
      installationId,
    )
    .run();
  await writeAudit(env, installationId, "discord.setup.apply", setup.guildId, {
    templateId: setup.template.id,
    createdChannels: result.createdChannels.length,
    createdRoles: result.createdRoles.length,
    permissionOverwritesApplied: result.permissionOverwritesApplied,
    starterMessagesPosted: result.starterMessagesPosted,
    operatorRoleId,
    needsContinuation: result.needsContinuation,
    mutationsApplied: result.mutationsApplied,
  });
  return json({
    ...result,
    config: await getSafeHostedDiscordConfig(env, installationId),
  });
};

const hostedDiscordSetupOptions = (
  input: Record<string, unknown>,
  config: DiscordConfigRow,
) => {
  const template = getDiscordSetupTemplate(
    optionalBoundedString(input.templateId, "Discord setup template ID", 80) ??
      config.setup_template_id ??
      undefined,
  );
  return {
    guildId: discordSnowflakeInput(config.guild_id, "Discord server ID"),
    template,
    includeRoles:
      input.includeRoles === undefined ? true : Boolean(input.includeRoles),
    applyPermissions:
      input.applyPermissions === undefined
        ? true
        : Boolean(input.applyPermissions),
    postStarterMessages:
      input.postStarterMessages === undefined
        ? Boolean(template.postStarterMessagesByDefault)
        : Boolean(input.postStarterMessages),
    existingMessageIds: jsonRecord(config.created_message_ids_json),
  };
};

const createHostedDiscordClient = (env: RelayEnv) =>
  new DiscordApiClient({
    botToken: requiredEnv(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN"),
    apiBaseUrl: env.DISCORD_API_BASE_URL,
  });

const requireHostedDiscordGuild = async (
  env: RelayEnv,
  installationId: string,
) => {
  const config = await getDiscordConfig(env, installationId);
  if (!config?.guild_id && !env.DISCORD_GUILD_ID) {
    throw new HttpError(
      409,
      "Connect Discord before previewing or applying hosted server setup.",
    );
  }
  if (!config?.guild_id && env.DISCORD_GUILD_ID) {
    await upsertDiscordConfig(env, installationId);
    const fallback = await getDiscordConfig(env, installationId);
    if (fallback?.guild_id) return fallback;
  }
  return config as DiscordConfigRow;
};

const storeDiscordInstall = async (
  env: RelayEnv,
  input: {
    installationId: string;
    applicationId: string;
    guildId: string;
    guildName: string | null;
    installedAt: string;
  },
) => {
  await env.DB.prepare(
    `
      INSERT INTO discord_configs (
        id, installation_id, application_id, guild_id, guild_name,
        operator_role_id, interaction_url, installed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        application_id = excluded.application_id,
        guild_id = excluded.guild_id,
        guild_name = excluded.guild_name,
        operator_role_id = COALESCE(
          discord_configs.operator_role_id,
          excluded.operator_role_id
        ),
        interaction_url = excluded.interaction_url,
        installed_at = excluded.installed_at,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      crypto.randomUUID(),
      input.installationId,
      input.applicationId,
      input.guildId,
      input.guildName,
      env.DISCORD_OPERATOR_ROLE_ID ?? null,
      discordInteractionUrl(env),
      input.installedAt,
      input.installedAt,
      input.installedAt,
    )
    .run();
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
  const messageType =
    request.headers.get("Twitch-Eventsub-Message-Type") ??
    envelope.metadata?.message_type;
  if (messageType === "webhook_callback_verification") {
    return new Response(
      envelope.challenge ?? envelope.payload?.challenge ?? "",
      {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
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
  const idempotencyKey = optionalBoundedString(
    input.idempotencyKey ?? input.idempotency_key,
    "Idempotency key",
    120,
  );
  if (idempotencyKey) {
    const existing = await getOutboundSendByIdempotencyKey(
      env,
      installationId,
      idempotencyKey,
    );
    if (existing) {
      return json({
        ok: existing.status === "sent",
        messageId: existing.twitch_message_id ?? "",
        transport: "relay-chatbot",
        idempotentReplay: true,
        status: existing.status,
        failureCategory: existing.failure_category ?? undefined,
        reason: existing.final_drop_reason ?? existing.reason ?? undefined,
        retryAfterMs: existing.retry_after_ms ?? undefined,
        nextRetryAt: existing.next_retry_at ?? undefined,
      });
    }
  }
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
  const persistence = outboundSendPersistence({
    sent,
    retryAfterMs: retryAfterMs(result.response),
    fallbackReason: dropReason || `Twitch response ${result.response.status}`,
    now,
  });
  await env.DB.prepare(
    `
      INSERT INTO outbound_chat_sends (
        id, installation_id, broadcaster_user_id, sender_user_id, message,
        status, twitch_message_id, failure_category, reason, retry_after_ms,
        idempotency_key, retry_count, next_retry_at, dead_lettered_at,
        final_drop_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      broadcasterGrant.user_id,
      botGrant.user_id,
      message,
      persistence.status,
      stringFrom(data?.message_id),
      sent ? null : "twitch_rejected",
      sent ? null : persistence.reason,
      persistence.retryAfterMs,
      idempotencyKey,
      persistence.retryCount,
      persistence.nextRetryAt,
      persistence.deadLetteredAt,
      persistence.finalDropReason,
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
    idempotentReplay: false,
  });
};

export const processOutboundRetryQueue = async (
  env: RelayEnv,
  options: { now?: string; limit?: number } = {},
) => {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? outboundRetryBatchLimit)),
    100,
  );
  const rows = await env.DB.prepare(
    `
      SELECT *
      FROM outbound_chat_sends
      WHERE status = 'retry'
        AND dead_lettered_at IS NULL
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY COALESCE(next_retry_at, created_at) ASC
      LIMIT ?
    `,
  )
    .bind(now, limit)
    .all<OutboundChatSendRow>();
  const summary = {
    ok: true,
    processed: rows.results.length,
    sent: 0,
    retry: 0,
    failed: 0,
    errors: 0,
    maxAttempts: maxOutboundRetryAttempts,
  };
  if (rows.results.length === 0) {
    return summary;
  }

  let appAccessToken = "";
  try {
    const appToken = await getAppAccessToken({
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
    });
    appAccessToken = appToken.access_token;
  } catch (error) {
    await writeAudit(env, null, "chat.retry.worker", "app-token", {
      ok: false,
      error: error instanceof Error ? error.message : "App token unavailable.",
    });
    return { ...summary, ok: false, errors: rows.results.length };
  }

  for (const row of rows.results) {
    try {
      const result = await retryOutboundChatSend(env, row, appAccessToken, now);
      summary[result.status] += 1;
    } catch (error) {
      summary.errors += 1;
      await markRetryWorkerFailure(env, row, now, error);
    }
  }

  return summary;
};

const retryOutboundChatSend = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  appAccessToken: string,
  now: string,
) => {
  const result = await sendAppTokenChatMessage({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken,
    broadcasterId: row.broadcaster_user_id,
    senderId: row.sender_user_id,
    message: row.message,
  });
  const data = getFirstDataItem(result.body);
  const dropReason = data?.drop_reason ? JSON.stringify(data.drop_reason) : "";
  const sent = result.response.ok && data?.is_sent !== false;
  const persistence = outboundRetryPersistence({
    sent,
    retryAfterMs: retryAfterMs(result.response),
    fallbackReason: dropReason || `Twitch response ${result.response.status}`,
    now,
    currentRetryCount: row.retry_count,
    maxRetryCount: maxOutboundRetryAttempts,
  });

  await persistRetryResult(env, row, persistence, stringFrom(data?.message_id));
  await writeAudit(
    env,
    row.installation_id,
    retryAuditAction(persistence.status),
    row.id,
    {
      ok: persistence.status === "sent",
      status: result.response.status,
      retryCount: persistence.retryCount,
      nextRetryAt: persistence.nextRetryAt,
      finalDropReason: persistence.finalDropReason,
    },
  );
  return persistence;
};

const markRetryWorkerFailure = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  now: string,
  error: unknown,
) => {
  const persistence = outboundRetryPersistence({
    sent: false,
    retryAfterMs: defaultRetryBackoffMs,
    fallbackReason:
      error instanceof Error ? error.message : "Retry worker send failed.",
    now,
    currentRetryCount: row.retry_count,
    maxRetryCount: maxOutboundRetryAttempts,
  });
  await persistRetryResult(env, row, persistence, null);
  await writeAudit(
    env,
    row.installation_id,
    retryAuditAction(persistence.status),
    row.id,
    {
      ok: false,
      retryCount: persistence.retryCount,
      nextRetryAt: persistence.nextRetryAt,
      finalDropReason: persistence.finalDropReason,
    },
  );
};

const persistRetryResult = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  persistence: ReturnType<typeof outboundRetryPersistence>,
  twitchMessageId: string | null,
) =>
  env.DB.prepare(
    `
      UPDATE outbound_chat_sends
      SET status = ?,
        twitch_message_id = ?,
        failure_category = ?,
        reason = ?,
        retry_after_ms = ?,
        retry_count = ?,
        next_retry_at = ?,
        dead_lettered_at = ?,
        final_drop_reason = ?,
        updated_at = ?
      WHERE id = ? AND status = 'retry'
    `,
  )
    .bind(
      persistence.status,
      twitchMessageId,
      persistence.status === "sent" ? null : "twitch_retry",
      persistence.reason,
      persistence.retryAfterMs,
      persistence.retryCount,
      persistence.nextRetryAt,
      persistence.deadLetteredAt,
      persistence.finalDropReason,
      persistence.updatedAt,
      row.id,
    )
    .run();

const retryAuditAction = (status: "sent" | "retry" | "failed") => {
  if (status === "sent") return "chat.retry.sent";
  if (status === "retry") return "chat.retry.scheduled";
  return "chat.retry.dead_letter";
};

const handleDiscordInteractionWebhook = async (
  request: Request,
  env: RelayEnv,
  url: URL,
  ctx: ExecutionContext,
) => {
  const body = await readBoundedText(request, maxJsonBytes);
  const publicKey = env.DISCORD_PUBLIC_KEY ?? "";
  const signature = headerValue(request, "X-Signature-Ed25519");
  const timestamp = headerValue(request, "X-Signature-Timestamp");
  const verified = await verifyDiscordInteractionSignature({
    publicKey,
    signature,
    timestamp,
    body,
  });
  if (!verified) {
    throw new HttpError(
      401,
      "Discord interaction signature verification failed.",
    );
  }

  const interaction = JSON.parse(body) as DiscordInteraction;
  if (
    env.DISCORD_APPLICATION_ID &&
    interaction.application_id !== env.DISCORD_APPLICATION_ID
  ) {
    throw new HttpError(
      403,
      "Discord application ID does not match Relay configuration.",
    );
  }
  if (interaction.type === discordInteractionType.ping) {
    return json({ type: discordInteractionResponseType.pong });
  }
  if (interaction.type !== discordInteractionType.applicationCommand) {
    return json(
      discordEphemeralResponse("Unsupported Discord interaction type."),
    );
  }
  const installation = await resolveDiscordInstallation(env, url, interaction);
  if (!installation) {
    return json(
      discordEphemeralResponse(
        "VaexCore Relay is not paired with Console yet.",
      ),
    );
  }
  await upsertDiscordConfig(env, installation.id);
  const configuredGuildId = await getDiscordGuildId(env, installation.id);
  if (
    !configuredGuildId ||
    !discordInteractionMatchesConfiguredGuild(interaction, configuredGuildId)
  ) {
    return json(
      discordEphemeralResponse(
        "VaexCore Relay is not configured for this Discord server.",
      ),
    );
  }
  const response = await queueDiscordInteraction(
    env,
    installation.id,
    interaction,
  );
  ctx.waitUntil(
    writeAudit(
      env,
      installation.id,
      "discord.interaction.received",
      interaction.id ?? null,
      {
        command: interaction.data?.name,
        guildId: interaction.guild_id,
      },
    ),
  );
  return json(response);
};

const queueDiscordInteraction = async (
  env: RelayEnv,
  installationId: string,
  interaction: DiscordInteraction,
) => {
  const commandName = (interaction.data?.name ?? "unknown").toLowerCase();
  const kind = discordCommandKind(commandName);
  const user = discordInteractionUser(interaction);
  const now = new Date().toISOString();
  const operatorRoleId = await getDiscordOperatorRoleId(env, installationId);
  const event = {
    id: interaction.id ?? crypto.randomUUID(),
    commandName,
    kind,
    userId: user.id,
    username: user.username,
    guildId: interaction.guild_id ?? "",
    channelId: interaction.channel_id ?? "",
    options: discordOptionRecord(interaction),
    allowed:
      !isDiscordAnnouncementCommand(commandName) &&
      commandName !== "setup-status"
        ? true
        : hasDiscordOperatorPermission(interaction, operatorRoleId),
    receivedAt: now,
  };

  if (!event.allowed) {
    await storeDiscordInteraction(
      env,
      installationId,
      interaction,
      event,
      "denied",
    );
    return discordEphemeralResponse(
      "This VaexCore command requires an allowed operator role or Manage Server permission.",
    );
  }

  if (commandName === "suggest") {
    const text = discordOptionString(interaction, "text", 1_000);
    if (!text) {
      await storeDiscordInteraction(
        env,
        installationId,
        interaction,
        event,
        "failed",
      );
      return discordEphemeralResponse(
        "Add suggestion text with /suggest text: ...",
      );
    }
    await storeDiscordInteraction(
      env,
      installationId,
      interaction,
      event,
      "queued",
    );
    await env.DB.prepare(
      `
        INSERT OR IGNORE INTO discord_suggestions (
          id, installation_id, discord_interaction_id, user_id, username,
          suggestion_text, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
      .bind(
        crypto.randomUUID(),
        installationId,
        event.id,
        event.userId,
        event.username,
        text,
        "new",
        now,
        now,
      )
      .run();
    await writeAudit(
      env,
      installationId,
      "discord.suggestion.queued",
      event.id,
      {
        userId: event.userId,
      },
    );
    return discordEphemeralResponse("Suggestion sent to VaexCore Console.");
  }

  if (isDiscordAnnouncementCommand(commandName)) {
    await storeDiscordInteraction(
      env,
      installationId,
      interaction,
      event,
      "queued",
    );
    await writeAudit(
      env,
      installationId,
      "discord.announcement.queued",
      event.id,
      {
        command: commandName,
        userId: event.userId,
      },
    );
    return discordEphemeralResponse(
      "Announcement queued for VaexCore Console review.",
    );
  }

  if (commandName === "setup-status") {
    await storeDiscordInteraction(
      env,
      installationId,
      interaction,
      event,
      "processed",
    );
    const readiness = await getDiscordReadiness(env, installationId);
    const failing = readiness.checks
      .filter((check) => !check.ok)
      .map((check) => check.key);
    return discordEphemeralResponse(
      failing.length > 0
        ? `VaexCore Discord setup needs attention: ${failing.join(", ")}.`
        : "VaexCore Discord setup is ready.",
    );
  }

  await storeDiscordInteraction(
    env,
    installationId,
    interaction,
    event,
    "failed",
  );
  return discordEphemeralResponse("Unknown VaexCore Discord command.");
};

const storeDiscordInteraction = async (
  env: RelayEnv,
  installationId: string,
  interaction: DiscordInteraction,
  event: Record<string, unknown>,
  status: DiscordInteractionRow["status"],
) =>
  env.DB.prepare(
    `
      INSERT OR IGNORE INTO discord_interactions (
        id, installation_id, discord_interaction_id, command_name,
        payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      interaction.id ?? crypto.randomUUID(),
      typeof event.commandName === "string" ? event.commandName : "unknown",
      JSON.stringify(event),
      status,
      typeof event.receivedAt === "string"
        ? event.receivedAt
        : new Date().toISOString(),
    )
    .run();

const updateDiscordConfig = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const operatorRoleId = discordSnowflakeInput(
    input.operatorRoleId,
    "Discord operator role ID",
  );
  const now = new Date().toISOString();
  await upsertDiscordConfig(env, installationId);
  await env.DB.prepare(
    `
      UPDATE discord_configs
      SET operator_role_id = ?, updated_at = ?
      WHERE installation_id = ?
    `,
  )
    .bind(operatorRoleId, now, installationId)
    .run();
  await writeAudit(
    env,
    installationId,
    "discord.config.update",
    installationId,
    {
      operatorRoleId,
    },
  );
  return json({ ok: true, operatorRoleId, updatedAt: now });
};

const registerDiscordCommands = async (
  env: RelayEnv,
  installationId: string,
  ctx: ExecutionContext,
) => {
  const applicationId = requiredEnv(
    env.DISCORD_APPLICATION_ID,
    "DISCORD_APPLICATION_ID",
  );
  const botToken = requiredEnv(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN");
  await upsertDiscordConfig(env, installationId);
  const guildId = await getDiscordGuildId(env, installationId);
  if (!guildId) {
    throw new HttpError(
      409,
      "Connect Discord before registering guild slash commands.",
    );
  }
  const result = await registerDiscordApplicationCommands({
    applicationId,
    botToken,
    guildId,
  });
  const now = new Date().toISOString();
  const status = result.response.ok ? "registered" : "failed";
  await env.DB.prepare(
    `
      INSERT INTO discord_command_registrations (
        id, installation_id, application_id, guild_id, commands_json,
        status, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      applicationId,
      guildId,
      JSON.stringify(discordApplicationCommands()),
      status,
      JSON.stringify(redact(result.body)),
      now,
    )
    .run();
  ctx.waitUntil(
    writeAudit(
      env,
      installationId,
      "discord.commands.register",
      applicationId,
      {
        ok: result.response.ok,
        status: result.response.status,
        scope: result.scope,
      },
    ),
  );
  if (!result.response.ok) {
    throw new HttpError(
      result.response.status,
      "Discord rejected slash command registration.",
    );
  }
  return json({
    ok: true,
    scope: result.scope,
    registeredAt: now,
    commands: discordApplicationCommands().map((command) => command.name),
  });
};

const getQueuedDiscordEvents = async (
  env: RelayEnv,
  installationId: string,
  limit: number,
) => {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 100)
    : 25;
  const rows = await env.DB.prepare(
    `
      SELECT id, payload_json
      FROM discord_interactions
      WHERE installation_id = ? AND status = 'queued' AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `,
  )
    .bind(installationId, safeLimit)
    .all<{ id: string; payload_json: string }>();
  const events = rows.results.map((row) => ({
    relayEventId: row.id,
    ...JSON.parse(row.payload_json),
  }));
  if (rows.results.length > 0) {
    const now = new Date().toISOString();
    await env.DB.batch(
      rows.results.map((row) =>
        env.DB.prepare(
          "UPDATE discord_interactions SET status = 'delivered', delivered_at = ? WHERE id = ?",
        ).bind(now, row.id),
      ),
    );
  }
  return json({ ok: true, events });
};

const getDiscordSuggestions = async (
  env: RelayEnv,
  installationId: string,
  requestedStatus: string | null,
  limit: number,
) => {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 100)
    : 50;
  const status = requestedStatus ? suggestionStatus(requestedStatus) : null;
  const query = status
    ? `
        SELECT *
        FROM discord_suggestions
        WHERE installation_id = ? AND status = ?
        ORDER BY created_at ASC
        LIMIT ?
      `
    : `
        SELECT *
        FROM discord_suggestions
        WHERE installation_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `;
  const rows = status
    ? await env.DB.prepare(query)
        .bind(installationId, status, safeLimit)
        .all<DiscordSuggestionRow>()
    : await env.DB.prepare(query)
        .bind(installationId, safeLimit)
        .all<DiscordSuggestionRow>();
  return json({
    ok: true,
    suggestions: rows.results.map(safeDiscordSuggestion),
  });
};

const updateDiscordSuggestionStatus = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const id = stringInput(input.id, "Suggestion ID", 80);
  const status = suggestionStatus(input.status);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `
      UPDATE discord_suggestions
      SET status = ?, updated_at = ?
      WHERE id = ? AND installation_id = ?
    `,
  )
    .bind(status, now, id, installationId)
    .run();
  if (!result.meta?.changes) {
    throw new HttpError(404, "Discord suggestion was not found.");
  }
  await writeAudit(env, installationId, "discord.suggestion.status", id, {
    status,
  });
  return json({ ok: true, id, status, updatedAt: now });
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
  return {
    ok: true,
    detail: "Bot and broadcaster accounts are separate.",
  };
};

const getDiscordReadiness = async (
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

const getBotReadinessReport = async (
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

const getSchemaReadiness = async (
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

const getQueueHealth = async (
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

const getFreshness = async (
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
        status: OutboundChatSendRow["status"];
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
      .all<{ status: DiscordSuggestionStatus; count: number }>(),
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
  const suggestions: Record<DiscordSuggestionStatus, number> = {
    new: 0,
    reviewed: 0,
    accepted: 0,
    rejected: 0,
    archived: 0,
  };
  for (const row of suggestionRows.results) {
    suggestions[row.status] = row.count;
  }
  return {
    queuedTwitchChatEvents,
    queuedDiscordInteractions,
    suggestions,
    outboundSends,
  };
};

const getLatestReadinessRecords = async (
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

const latestRecordMetadata = (
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
  if (!record) {
    return { present: false };
  }
  return {
    present: true,
    ...Object.fromEntries(fields.map((field) => [field, record[field] ?? ""])),
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

const ageMs = (generatedAt: string, timestamp: string | null | undefined) => {
  if (!timestamp) return null;
  const generated = Date.parse(generatedAt);
  const then = Date.parse(timestamp);
  if (!Number.isFinite(generated) || !Number.isFinite(then)) return null;
  return Math.max(0, generated - then);
};

const getAdminDiagnostics = async (env: RelayEnv) => {
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
  return {
    recent: rows.results.map((row) => redact(row)),
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

const resolveDiscordInstallation = async (
  env: RelayEnv,
  url: URL,
  interaction: DiscordInteraction,
) => {
  const installationId = url.searchParams.get("installationId");
  if (installationId) {
    return getInstallation(env, installationId);
  }
  if (interaction.guild_id) {
    const configured = await env.DB.prepare(
      `
        SELECT installations.*
        FROM installations
        INNER JOIN discord_configs ON discord_configs.installation_id = installations.id
        WHERE discord_configs.guild_id = ?
        ORDER BY installations.created_at ASC
        LIMIT 1
      `,
    )
      .bind(interaction.guild_id)
      .first<InstallationRow>();
    if (configured) {
      return configured;
    }
  }
  return env.DB.prepare(
    "SELECT * FROM installations ORDER BY created_at ASC LIMIT 1",
  ).first<InstallationRow>();
};

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

const getLatestDiscordCommandRegistration = (
  env: RelayEnv,
  installationId: string,
) =>
  env.DB.prepare(
    `
      SELECT *
      FROM discord_command_registrations
      WHERE installation_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
  )
    .bind(installationId)
    .first<DiscordCommandRegistrationRow>();

const getDiscordConfig = (env: RelayEnv, installationId: string) =>
  env.DB.prepare(
    `
      SELECT *
      FROM discord_configs
      WHERE installation_id = ?
      LIMIT 1
    `,
  )
    .bind(installationId)
    .first<DiscordConfigRow>();

const getDiscordGuildId = async (env: RelayEnv, installationId: string) => {
  const row = await getDiscordConfig(env, installationId);
  return row?.guild_id || env.DISCORD_GUILD_ID;
};

const getDiscordOperatorRoleId = async (
  env: RelayEnv,
  installationId: string,
) => {
  const row = await env.DB.prepare(
    `
      SELECT operator_role_id
      FROM discord_configs
      WHERE installation_id = ?
      LIMIT 1
    `,
  )
    .bind(installationId)
    .first<{ operator_role_id: string | null }>();
  return row?.operator_role_id || env.DISCORD_OPERATOR_ROLE_ID;
};

const getSafeHostedDiscordConfig = async (
  env: RelayEnv,
  installationId: string,
  configInput?: DiscordConfigRow,
) => {
  const config = configInput ?? (await getDiscordConfig(env, installationId));
  const guildId = config?.guild_id ?? env.DISCORD_GUILD_ID ?? "";
  return {
    connected: Boolean(config?.guild_id),
    guildId,
    guildName: config?.guild_name ?? "",
    installedAt: config?.installed_at ?? "",
    setupTemplateId: config?.setup_template_id ?? getDiscordSetupTemplate().id,
    setupAppliedAt: config?.setup_applied_at ?? "",
    starterMessagesAppliedAt: config?.starter_messages_applied_at ?? "",
    streamAnnouncementChannelId: config?.stream_announcement_channel_id ?? "",
    generalAnnouncementChannelId: config?.general_announcement_channel_id ?? "",
    suggestionChannelId: config?.suggestion_channel_id ?? "",
    streamAlertsRoleId: config?.stream_alerts_role_id ?? "",
    operatorRoleId:
      config?.operator_role_id ?? env.DISCORD_OPERATOR_ROLE_ID ?? "",
    createdChannelIds: jsonRecord(config?.created_channel_ids_json),
    createdRoleIds: jsonRecord(config?.created_role_ids_json),
    createdMessageIds: jsonRecord(config?.created_message_ids_json),
    interactionUrl: discordInteractionUrl(env),
    redirectUri: discordRedirectUri(env),
    permissions: discordHostedInstallPermissions(),
    hasApplicationId: Boolean(env.DISCORD_APPLICATION_ID),
    hasClientSecret: Boolean(env.DISCORD_CLIENT_SECRET),
    hasBotToken: Boolean(env.DISCORD_BOT_TOKEN),
  };
};

const safeDiscordTemplateSummary = (
  template: (typeof discordSetupTemplates)[number],
) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  recommendedFor: template.recommendedFor ?? "",
  channelCount: template.channels.filter(
    (channel) => channel.kind !== "category",
  ).length,
  categoryCount: template.channels.filter(
    (channel) => channel.kind === "category",
  ).length,
  roleCount: template.roles.length,
  starterMessageCount: template.starterMessages?.length ?? 0,
  postStarterMessagesByDefault: Boolean(template.postStarterMessagesByDefault),
});

const getOutboundSendByIdempotencyKey = (
  env: RelayEnv,
  installationId: string,
  idempotencyKey: string,
) =>
  env.DB.prepare(
    `
      SELECT *
      FROM outbound_chat_sends
      WHERE installation_id = ? AND idempotency_key = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
  )
    .bind(installationId, idempotencyKey)
    .first<OutboundChatSendRow>();

const upsertDiscordConfig = async (env: RelayEnv, installationId: string) => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO discord_configs (
        id, installation_id, application_id, guild_id, operator_role_id,
        interaction_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        application_id = excluded.application_id,
        guild_id = COALESCE(discord_configs.guild_id, excluded.guild_id),
        operator_role_id = COALESCE(
          discord_configs.operator_role_id,
          excluded.operator_role_id
        ),
        interaction_url = excluded.interaction_url,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      env.DISCORD_APPLICATION_ID ?? null,
      env.DISCORD_GUILD_ID ?? null,
      env.DISCORD_OPERATOR_ROLE_ID ?? null,
      discordInteractionUrl(env),
      now,
      now,
    )
    .run();
};

const safeInstallation = (installation: InstallationRow) => ({
  id: installation.id,
  name: installation.name,
  botLogin: installation.bot_login ?? "",
  broadcasterLogin: installation.broadcaster_login ?? "",
  createdAt: installation.created_at,
  updatedAt: installation.updated_at,
});

const safeDiscordSuggestion = (row: DiscordSuggestionRow) => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  text: row.suggestion_text,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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

const discordSnowflakeInput = (value: unknown, field: string) => {
  const snowflake = stringInput(value, field, 32);
  if (!/^\d{5,32}$/.test(snowflake)) {
    throw new HttpError(400, `${field} must be a Discord ID.`);
  }
  return snowflake;
};

const optionalBoundedString = (
  value: unknown,
  field: string,
  maxLength: number,
) => {
  if (value === undefined || value === null || value === "") return null;
  return stringInput(value, field, maxLength);
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

const jsonRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, item]) => typeof item === "string")
        .map(([key, item]) => [key, item as string]),
    );
  } catch {
    return {};
  }
};

const requiredEnv = (value: string | undefined, name: string) => {
  if (!value?.trim()) {
    throw new HttpError(409, `${name} is not configured.`);
  }
  return value.trim();
};

const suggestionStatus = (value: unknown): DiscordSuggestionStatus => {
  if (
    value === "new" ||
    value === "reviewed" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "archived"
  ) {
    return value;
  }
  throw new HttpError(
    400,
    "Suggestion status must be new, reviewed, accepted, rejected, or archived.",
  );
};

const discordInteractionUrl = (env: RelayEnv) =>
  `${env.PUBLIC_BASE_URL}/webhooks/discord/interactions`;

const discordRedirectUri = (env: RelayEnv) =>
  `${env.PUBLIC_BASE_URL}/oauth/discord/callback`;

const retryAfterMs = (response: Response) => {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

export const outboundSendPersistence = (input: {
  sent: boolean;
  retryAfterMs: number | null;
  fallbackReason: string;
  now: string;
}) => {
  const nextRetryAt = input.retryAfterMs
    ? new Date(Date.parse(input.now) + input.retryAfterMs).toISOString()
    : null;
  const status = input.sent ? "sent" : input.retryAfterMs ? "retry" : "failed";
  const deadLetteredAt = !input.sent && !input.retryAfterMs ? input.now : null;
  return {
    status,
    reason: input.sent ? null : input.fallbackReason,
    retryAfterMs: input.retryAfterMs,
    retryCount: input.sent ? 0 : 1,
    nextRetryAt,
    deadLetteredAt,
    finalDropReason: deadLetteredAt ? input.fallbackReason : null,
  } as const;
};

export const outboundRetryPersistence = (input: {
  sent: boolean;
  retryAfterMs: number | null;
  fallbackReason: string;
  now: string;
  currentRetryCount: number;
  maxRetryCount: number;
}) => {
  const retryCount = input.currentRetryCount + 1;
  const canRetry =
    !input.sent &&
    input.retryAfterMs !== null &&
    retryCount < input.maxRetryCount;
  const status = input.sent ? "sent" : canRetry ? "retry" : "failed";
  const nextRetryAt = canRetry
    ? new Date(Date.parse(input.now) + input.retryAfterMs!).toISOString()
    : null;
  const deadLetteredAt = status === "failed" ? input.now : null;
  return {
    status,
    reason: input.sent ? null : input.fallbackReason,
    retryAfterMs: input.sent ? null : input.retryAfterMs,
    retryCount,
    nextRetryAt,
    deadLetteredAt,
    finalDropReason: deadLetteredAt ? input.fallbackReason : null,
    updatedAt: input.now,
  } as const;
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
