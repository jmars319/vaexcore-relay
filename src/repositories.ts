import { constantTimeEqual, sha256Base64Url } from "./crypto";
import {
  discordHostedInstallPermissions,
  type DiscordInteraction,
} from "./discord";
import {
  getDiscordSetupTemplate,
  discordSetupTemplates,
} from "./console-shared/discord/templates";
import type { DiscordConfigRow, RelayEnv } from "./env";
import {
  bearerToken,
  discordInteractionUrl,
  discordRedirectUri,
  HttpError,
  jsonRecord,
  redact,
  stringInput,
} from "./http";
import type {
  DiscordCommandRegistrationRow,
  DiscordSuggestionRow,
  InstallationRow,
  OAuthGrantKind,
  OAuthGrantRow,
  OutboundChatSendRow,
} from "./types";

export const getInstallation = (env: RelayEnv, id: string) =>
  env.DB.prepare("SELECT * FROM installations WHERE id = ?")
    .bind(id)
    .first<InstallationRow>();

export const findInstallationForBroadcaster = (
  env: RelayEnv,
  broadcasterUserId: string,
) =>
  env.DB.prepare("SELECT * FROM installations WHERE broadcaster_user_id = ?")
    .bind(broadcasterUserId)
    .first<InstallationRow>();

export const resolveDiscordInstallation = async (
  env: RelayEnv,
  url: URL,
  interaction: DiscordInteraction,
) => {
  const installationId = url.searchParams.get("installationId");
  if (installationId) return getInstallation(env, installationId);
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
    if (configured) return configured;
  }
  return env.DB.prepare(
    "SELECT * FROM installations ORDER BY created_at ASC LIMIT 1",
  ).first<InstallationRow>();
};

export const getGrant = (
  env: RelayEnv,
  installationId: string,
  kind: OAuthGrantKind,
) =>
  env.DB.prepare(
    "SELECT * FROM oauth_grants WHERE installation_id = ? AND grant_kind = ?",
  )
    .bind(installationId, kind)
    .first<OAuthGrantRow>();

export const getLatestDiscordCommandRegistration = (
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

export const getDiscordConfig = (env: RelayEnv, installationId: string) =>
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

export const getDiscordGuildId = async (
  env: RelayEnv,
  installationId: string,
) => {
  const row = await getDiscordConfig(env, installationId);
  return row?.guild_id || env.DISCORD_GUILD_ID;
};

export const getDiscordOperatorRoleId = async (
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

export const getSafeHostedDiscordConfig = async (
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

export const safeDiscordTemplateSummary = (
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

export const getOutboundSendByIdempotencyKey = (
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

export const upsertDiscordConfig = async (
  env: RelayEnv,
  installationId: string,
) => {
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

export const safeInstallation = (installation: InstallationRow) => ({
  id: installation.id,
  name: installation.name,
  botLogin: installation.bot_login ?? "",
  broadcasterLogin: installation.broadcaster_login ?? "",
  createdAt: installation.created_at,
  updatedAt: installation.updated_at,
});

export const safeDiscordSuggestion = (row: DiscordSuggestionRow) => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  text: row.suggestion_text,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const writeAudit = async (
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

export const requireAdmin = async (request: Request, env: RelayEnv) => {
  const token = bearerToken(request);
  if (
    !env.RELAY_ADMIN_TOKEN ||
    !token ||
    !constantTimeEqual(token, env.RELAY_ADMIN_TOKEN)
  ) {
    throw new HttpError(401, "Relay admin authorization is required.");
  }
};

export const requireConsole = async (
  request: Request,
  env: RelayEnv,
  url: URL,
) => {
  const installationId = stringInput(
    url.searchParams.get("installationId"),
    "Installation ID",
    80,
  );
  const installation = await getInstallation(env, installationId);
  if (!installation) throw new HttpError(404, "Installation was not found.");
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

export const requireRelayReadyGrants = async (
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
