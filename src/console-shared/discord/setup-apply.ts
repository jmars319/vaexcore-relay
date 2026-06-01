import { SafeInputError, parseSafeInteger } from "../core/security";
import {
  DiscordHttpError,
  type DiscordApiClient,
  type DiscordGuildChannel,
  type DiscordGuildRole,
} from "./client";
import {
  discordChannelTypeCodes,
  defaultDiscordSetupTemplate,
  type DiscordSetupPermissionOverwriteTemplate,
  type DiscordSetupTemplate,
} from "./templates";
import type {
  DiscordCreatedStarterMessage,
  DiscordSetupApplyResult,
} from "./setup-types";
import {
  channelPermissionOverwriteMatches,
  findExistingChannel,
  findExistingRole,
  permissionBitfield,
  recordChannelPermissionOverwrite,
  viewChannelPermissionBit,
} from "./setup-helpers";
import { normalizeDiscordSnowflake } from "./setup-normalize";
import { planDiscordServerSetup } from "./setup-plan";

export const applyDiscordServerSetup = async (options: {
  client: DiscordApiClient;
  guildId: string;
  template?: DiscordSetupTemplate;
  includeRoles?: boolean;
  applyPermissions?: boolean;
  postStarterMessages?: boolean;
  existingMessageIds?: Record<string, string>;
  lockStaffCategory?: boolean;
  staffRoleId?: string;
  botUserId?: string;
  maxMutations?: number;
}): Promise<DiscordSetupApplyResult> => {
  const template = options.template ?? defaultDiscordSetupTemplate;
  const guildId = normalizeDiscordSnowflake(
    options.guildId,
    "Discord guild ID",
  );
  const existingChannels = await options.client.listGuildChannels(guildId);
  const existingRoles = await options.client.listGuildRoles(guildId);
  const includeRoles = options.includeRoles ?? false;
  const applyPermissions = options.applyPermissions ?? false;
  const postStarterMessages = options.postStarterMessages ?? false;
  const existingMessageIds = options.existingMessageIds ?? {};
  const lockStaffCategory = options.lockStaffCategory ?? false;
  const staffRoleId = options.staffRoleId
    ? normalizeDiscordSnowflake(options.staffRoleId, "Discord staff role ID")
    : "";
  const botUserId = options.botUserId
    ? normalizeDiscordSnowflake(options.botUserId, "Discord bot user ID")
    : "";
  const workingChannels = [...existingChannels];
  const workingRoles = [...existingRoles];
  const createdChannels: DiscordGuildChannel[] = [];
  const createdRoles: DiscordGuildRole[] = [];
  const channelIds: Record<string, string> = {};
  const roleIds: Record<string, string> = {};
  const createdMessageIds: Record<string, string> = {};
  const createdStarterMessages: DiscordCreatedStarterMessage[] = [];
  let permissionOverwritesApplied = 0;
  let mutationsApplied = 0;
  const maxMutations =
    options.maxMutations === undefined
      ? undefined
      : parseSafeInteger(options.maxMutations, {
          field: "Discord setup mutation limit",
          min: 1,
          max: 1000,
        });
  const hasMutationBudget = () =>
    maxMutations === undefined || mutationsApplied < maxMutations;
  const markMutationApplied = () => {
    mutationsApplied += 1;
  };
  const buildResult = (complete: boolean): DiscordSetupApplyResult => {
    const plan = planDiscordServerSetup({
      existingChannels: workingChannels,
      existingRoles: workingRoles,
      template,
      includeRoles,
      applyPermissions,
      postStarterMessages,
      existingMessageIds: {
        ...existingMessageIds,
        ...createdMessageIds,
      },
      guildId,
      lockStaffCategory,
      staffRoleId,
    });

    return {
      ok: true,
      appliedAt: new Date().toISOString(),
      plan,
      createdChannels,
      createdRoles,
      channelIds,
      roleIds,
      createdMessageIds,
      createdStarterMessages,
      recommended: {
        streamAnnouncementChannelId:
          channelIds[template.recommended.streamAnnouncementChannelId],
        generalAnnouncementChannelId:
          channelIds[template.recommended.generalAnnouncementChannelId],
        suggestionChannelId:
          channelIds[template.recommended.suggestionChannelId],
        streamAlertsRoleId: roleIds[template.recommended.streamAlertsRoleId],
        operatorRoleId: template.recommended.operatorRoleId
          ? roleIds[template.recommended.operatorRoleId]
          : undefined,
      },
      permissionOverwritesApplied,
      starterMessagesPosted: createdStarterMessages.length,
      starterMessagesSkipped: Object.keys(existingMessageIds).filter((id) =>
        (template.starterMessages ?? []).some((message) => message.id === id),
      ).length,
      complete,
      needsContinuation: !complete,
      mutationsApplied,
      maxMutations,
    };
  };

  if (lockStaffCategory && !staffRoleId) {
    throw new SafeInputError(
      "A Discord Staff role ID is required before locking the Staff category.",
    );
  }

  if (lockStaffCategory && staffRoleId === guildId) {
    throw new SafeInputError(
      "Staff category privacy cannot use the @everyone role. Select a dedicated staff/moderator role.",
    );
  }

  if (includeRoles) {
    for (const role of template.roles) {
      const existing = findExistingRole(workingRoles, role);
      if (existing) {
        roleIds[role.id] = existing.id;
        continue;
      }
      if (!hasMutationBudget()) {
        return buildResult(false);
      }

      const created = await options.client.createGuildRole(guildId, {
        name: role.name,
        permissions: permissionBitfield(role.permissions ?? []),
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
      });
      workingRoles.push(created);
      createdRoles.push(created);
      roleIds[role.id] = created.id;
      markMutationApplied();
    }
  } else {
    for (const role of template.roles) {
      const existing = findExistingRole(workingRoles, role);
      if (existing) {
        roleIds[role.id] = existing.id;
      }
    }
  }

  for (const channel of template.channels) {
    const parentDiscordId = channel.parentId
      ? channelIds[channel.parentId]
      : undefined;
    const existing = findExistingChannel(
      workingChannels,
      channel,
      parentDiscordId,
    );
    if (existing) {
      channelIds[channel.id] = existing.id;
      continue;
    }
    if (!hasMutationBudget()) {
      return buildResult(false);
    }

    const created = await options.client.createGuildChannel(guildId, {
      name: channel.name,
      type: discordChannelTypeCodes[channel.kind],
      parent_id: parentDiscordId,
      topic: channel.kind === "text" ? channel.topic : undefined,
      bitrate: channel.kind === "voice" ? channel.bitrate : undefined,
      user_limit: channel.kind === "voice" ? channel.userLimit : undefined,
      nsfw: channel.kind === "text" ? channel.nsfw : undefined,
    });
    workingChannels.push(created);
    createdChannels.push(created);
    channelIds[channel.id] = created.id;
    markMutationApplied();
  }

  if (applyPermissions) {
    if (botUserId) {
      const privateChannelTemplateIds = new Set(
        (template.permissionOverwrites ?? [])
          .filter(
            (overwrite) =>
              overwrite.roleId === "@everyone" &&
              (overwrite.deny ?? []).includes("view_channel"),
          )
          .map((overwrite) => overwrite.channelId),
      );
      for (const channelTemplateId of privateChannelTemplateIds) {
        const channelId = channelIds[channelTemplateId];
        if (!channelId) continue;
        const input = {
          type: 1 as const,
          allow: permissionBitfield([
            "view_channel",
            "read_message_history",
            "send_messages",
            "send_messages_in_threads",
            "embed_links",
            "attach_files",
          ]),
          deny: "0",
        };
        if (
          channelPermissionOverwriteMatches(
            workingChannels,
            channelId,
            botUserId,
            input,
          )
        ) {
          continue;
        }
        if (!hasMutationBudget()) {
          return buildResult(false);
        }
        try {
          await options.client.setChannelPermissionOverwrite(
            channelId,
            botUserId,
            input,
          );
          recordChannelPermissionOverwrite(
            workingChannels,
            channelId,
            botUserId,
            input,
          );
          markMutationApplied();
        } catch (error) {
          throw discordBotAccessOverwriteError(
            template,
            channelTemplateId,
            error,
          );
        }
      }
    }

    for (const overwrite of template.permissionOverwrites ?? []) {
      const channelId = channelIds[overwrite.channelId];
      const roleId =
        overwrite.roleId === "@everyone" ? guildId : roleIds[overwrite.roleId];
      if (!channelId || !roleId) {
        throw new SafeInputError(
          `Discord permission overwrite ${overwrite.id} could not be resolved.`,
        );
      }
      const input = {
        type: 0 as const,
        allow: permissionBitfield(overwrite.allow ?? []),
        deny: permissionBitfield(overwrite.deny ?? []),
      };
      if (
        channelPermissionOverwriteMatches(
          workingChannels,
          channelId,
          roleId,
          input,
        )
      ) {
        continue;
      }
      if (!hasMutationBudget()) {
        return buildResult(false);
      }
      try {
        await options.client.setChannelPermissionOverwrite(
          channelId,
          roleId,
          input,
        );
        recordChannelPermissionOverwrite(
          workingChannels,
          channelId,
          roleId,
          input,
        );
      } catch (error) {
        throw discordPermissionOverwriteError(template, overwrite, error);
      }
      permissionOverwritesApplied += 1;
      markMutationApplied();
    }
  }

  if (lockStaffCategory) {
    const staffCategoryId = channelIds["category-staff"];
    if (!staffCategoryId) {
      throw new SafeInputError(
        "The Staff category could not be resolved for privacy setup.",
      );
    }

    const everyoneInput = {
      type: 0 as const,
      allow: "0",
      deny: viewChannelPermissionBit,
    };
    if (
      !channelPermissionOverwriteMatches(
        workingChannels,
        staffCategoryId,
        guildId,
        everyoneInput,
      )
    ) {
      if (!hasMutationBudget()) {
        return buildResult(false);
      }
      await options.client.setChannelPermissionOverwrite(
        staffCategoryId,
        guildId,
        everyoneInput,
      );
      recordChannelPermissionOverwrite(
        workingChannels,
        staffCategoryId,
        guildId,
        everyoneInput,
      );
      permissionOverwritesApplied += 1;
      markMutationApplied();
    }

    const staffInput = {
      type: 0 as const,
      allow: viewChannelPermissionBit,
      deny: "0",
    };
    if (
      !channelPermissionOverwriteMatches(
        workingChannels,
        staffCategoryId,
        staffRoleId,
        staffInput,
      )
    ) {
      if (!hasMutationBudget()) {
        return buildResult(false);
      }
      await options.client.setChannelPermissionOverwrite(
        staffCategoryId,
        staffRoleId,
        staffInput,
      );
      recordChannelPermissionOverwrite(
        workingChannels,
        staffCategoryId,
        staffRoleId,
        staffInput,
      );
      permissionOverwritesApplied += 1;
      markMutationApplied();
    }
  }

  if (postStarterMessages) {
    for (const starterMessage of template.starterMessages ?? []) {
      if (existingMessageIds[starterMessage.id]) {
        continue;
      }
      const channelId = channelIds[starterMessage.channelId];
      if (!channelId) {
        throw new SafeInputError(
          `Discord starter message ${starterMessage.id} channel could not be resolved.`,
        );
      }
      if (!hasMutationBudget()) {
        return buildResult(false);
      }
      const result = await options.client.createMessage(channelId, {
        content: starterMessage.content,
        allowed_mentions: { parse: [] },
      });
      createdMessageIds[starterMessage.id] = result.id;
      createdStarterMessages.push({
        templateId: starterMessage.id,
        channelId,
        messageId: result.id,
      });
      markMutationApplied();
    }
  }

  return buildResult(true);
};

const discordPermissionOverwriteError = (
  template: DiscordSetupTemplate,
  overwrite: DiscordSetupPermissionOverwriteTemplate,
  error: unknown,
) => {
  const channelName =
    template.channels.find((channel) => channel.id === overwrite.channelId)
      ?.name ?? overwrite.channelId;
  const roleName =
    overwrite.roleId === "@everyone"
      ? "@everyone"
      : (template.roles.find((role) => role.id === overwrite.roleId)?.name ??
        overwrite.roleId);
  const detail =
    error instanceof DiscordHttpError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Discord denied the permission overwrite.";
  return new SafeInputError(
    `Discord could not apply permission overwrite ${overwrite.id} on ${channelName} for ${roleName}. ${detail}`,
  );
};

const discordBotAccessOverwriteError = (
  template: DiscordSetupTemplate,
  channelTemplateId: string,
  error: unknown,
) => {
  const channelName =
    template.channels.find((channel) => channel.id === channelTemplateId)
      ?.name ?? channelTemplateId;
  const detail =
    error instanceof DiscordHttpError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Discord denied the bot access overwrite.";
  return new SafeInputError(
    `Discord could not preserve VaexCore bot access on ${channelName}. ${detail}`,
  );
};
