import { constantTimeEqual, randomToken, sha256Base64Url } from "./crypto";
import {
  type DiscordInteraction,
  discordApplicationCommands,
  discordCommandKind,
  discordEphemeralResponse,
  discordInteractionResponseType,
  discordInteractionType,
  discordInteractionUser,
  discordOptionRecord,
  discordOptionString,
  hasDiscordOperatorPermission,
  isDiscordAnnouncementCommand,
  registerDiscordApplicationCommands,
  verifyDiscordInteractionSignature,
} from "./discord";
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
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_OPERATOR_ROLE_ID?: string;
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
          hasDiscordBotToken: Boolean(env.DISCORD_BOT_TOKEN),
          hasDiscordPublicKey: Boolean(env.DISCORD_PUBLIC_KEY),
          hasDiscordApplicationId: Boolean(env.DISCORD_APPLICATION_ID),
          hasDiscordGuildId: Boolean(env.DISCORD_GUILD_ID),
          discordInteractionUrl: discordInteractionUrl(env),
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
      if (
        request.method === "GET" &&
        url.pathname === "/api/console/discord/status"
      ) {
        const installation = await requireConsole(request, env, url);
        return json({
          ok: true,
          readiness: await getDiscordReadiness(env, installation.id),
        });
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
        return finishOAuth(url, env);
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
        : hasDiscordOperatorPermission(
            interaction,
            env.DISCORD_OPERATOR_ROLE_ID,
          ),
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
  const result = await registerDiscordApplicationCommands({
    applicationId,
    botToken,
    guildId: env.DISCORD_GUILD_ID,
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
      env.DISCORD_GUILD_ID ?? null,
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

const getDiscordReadiness = async (
  env: RelayEnv,
  installationId: string,
): Promise<DiscordReadiness> => {
  const [installation, latestRegistration] = await Promise.all([
    getInstallation(env, installationId),
    getLatestDiscordCommandRegistration(env, installationId),
  ]);
  const interactionUrl = discordInteractionUrl(env);
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
      key: "discord-guild-id",
      ok: Boolean(env.DISCORD_GUILD_ID),
      detail: env.DISCORD_GUILD_ID
        ? "Guild-scoped Discord command registration is configured."
        : "Set DISCORD_GUILD_ID for the target server before live validation.",
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
        guild_id = excluded.guild_id,
        operator_role_id = excluded.operator_role_id,
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
