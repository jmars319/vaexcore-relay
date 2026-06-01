import {
  type DiscordInteraction,
  discordCommandKind,
  discordEphemeralResponse,
  discordInteractionMatchesConfiguredGuild,
  discordInteractionResponseType,
  discordInteractionType,
  discordInteractionUser,
  discordOptionRecord,
  discordOptionString,
  hasDiscordOperatorPermission,
  isDiscordAnnouncementCommand,
  verifyDiscordInteractionSignature,
} from "../discord";
import { maxJsonBytes, type RelayEnv } from "../env";
import {
  HttpError,
  headerValue,
  json,
  objectInput,
  readBoundedText,
  stringInput,
  suggestionStatus,
} from "../http";
import {
  getDiscordGuildId,
  getDiscordOperatorRoleId,
  resolveDiscordInstallation,
  safeDiscordSuggestion,
  upsertDiscordConfig,
  writeAudit,
} from "../repositories";
import { getDiscordReadiness } from "../readiness";
import type { DiscordInteractionRow, DiscordSuggestionRow } from "../types";

export const handleDiscordInteractionWebhook = async (
  request: Request,
  env: RelayEnv,
  url: URL,
  ctx: ExecutionContext,
) => {
  const body = await readBoundedText(request, maxJsonBytes);
  const verified = await verifyDiscordInteractionSignature({
    publicKey: env.DISCORD_PUBLIC_KEY ?? "",
    signature: headerValue(request, "X-Signature-Ed25519"),
    timestamp: headerValue(request, "X-Signature-Timestamp"),
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
      { command: interaction.data?.name, guildId: interaction.guild_id },
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
      { command: commandName, userId: event.userId },
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

export const getQueuedDiscordEvents = async (
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

export const getDiscordSuggestions = async (
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

export const updateDiscordSuggestionStatus = async (
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
