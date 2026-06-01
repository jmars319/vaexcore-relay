import {
  buildDiscordInstallAuthorizeUrl,
  discordApplicationCommands,
  discordHostedInstallPermissions,
  exchangeDiscordOAuthCode,
  registerDiscordApplicationCommands,
  revokeDiscordOAuthToken,
} from "../discord";
import { randomToken } from "../crypto";
import { DiscordApiClient } from "../console-shared/discord/client";
import {
  applyDiscordServerSetup,
  planDiscordServerSetup,
} from "../console-shared/discord/setup";
import {
  discordSetupTemplates,
  getDiscordSetupTemplate,
} from "../console-shared/discord/templates";
import {
  hostedDiscordSetupMutationLimit,
  type DiscordConfigRow,
  type RelayEnv,
} from "../env";
import {
  discordInteractionUrl,
  discordRedirectUri,
  discordSnowflakeInput,
  html,
  HttpError,
  json,
  jsonRecord,
  objectInput,
  optionalBoundedString,
  redact,
  requiredEnv,
  stringFrom,
  stringInput,
} from "../http";
import {
  getDiscordConfig,
  getDiscordGuildId,
  getSafeHostedDiscordConfig,
  safeDiscordTemplateSummary,
  upsertDiscordConfig,
  writeAudit,
} from "../repositories";
import { getDiscordReadiness } from "../readiness";

export const startDiscordInstall = async (
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

export const finishDiscordInstall = async (
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

export const previewHostedDiscordSetup = async (
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

export const applyHostedDiscordSetup = async (
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

export const updateDiscordConfig = async (
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

export const registerDiscordCommands = async (
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

export const discordStatus = async (env: RelayEnv, installationId: string) =>
  json({
    ok: true,
    readiness: await getDiscordReadiness(env, installationId),
    config: await getSafeHostedDiscordConfig(env, installationId),
    templates: discordSetupTemplates.map(safeDiscordTemplateSummary),
  });
