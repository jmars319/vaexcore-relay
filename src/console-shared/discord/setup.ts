import {
  SafeInputError,
  parseSafeInteger,
  sanitizeText,
} from "../core/security";
import {
  DiscordHttpError,
  type DiscordApiClient,
  type DiscordCreateMessageInput,
  type DiscordGuildChannel,
  type DiscordPermissionOverwriteInput,
  type DiscordGuildRole,
} from "./client";
import {
  type DiscordAnnouncementKind,
  type DiscordChannelKind,
  type DiscordPermissionName,
  type DiscordSetupChannelTemplate,
  type DiscordSetupPermissionOverwriteTemplate,
  type DiscordSetupRoleTemplate,
  type DiscordSetupStarterMessageTemplate,
  type DiscordSetupTemplate,
  discordChannelTypeCodes,
  defaultDiscordSetupTemplate,
} from "./templates";

export type DiscordSetupActionType =
  | "create_channel"
  | "use_existing_channel"
  | "create_role"
  | "use_existing_role"
  | "skip_role"
  | "apply_permission_overwrite"
  | "blocked_permission"
  | "post_starter_message"
  | "skip_starter_message"
  | "blocked_starter_message";

export type DiscordSetupAction = {
  type: DiscordSetupActionType;
  templateId: string;
  name: string;
  kind?: DiscordChannelKind;
  discordId?: string;
  detail: string;
};

export type DiscordSetupPlan = {
  ok: true;
  template: Pick<DiscordSetupTemplate, "id" | "name" | "description">;
  includeRoles: boolean;
  applyPermissions: boolean;
  postStarterMessages: boolean;
  lockStaffCategory: boolean;
  actions: DiscordSetupAction[];
  summary: {
    channelsToCreate: number;
    existingChannels: number;
    rolesToCreate: number;
    existingRoles: number;
    skippedRoles: number;
    permissionOverwrites: number;
    blockedPermissions: number;
    starterMessagesToPost: number;
    starterMessagesSkipped: number;
    starterMessagesBlocked: number;
  };
};

export type DiscordCreatedStarterMessage = {
  templateId: string;
  channelId: string;
  messageId: string;
};

export type DiscordSetupApplyResult = {
  ok: true;
  appliedAt: string;
  plan: DiscordSetupPlan;
  createdChannels: DiscordGuildChannel[];
  createdRoles: DiscordGuildRole[];
  channelIds: Record<string, string>;
  roleIds: Record<string, string>;
  createdMessageIds: Record<string, string>;
  createdStarterMessages: DiscordCreatedStarterMessage[];
  recommended: {
    streamAnnouncementChannelId?: string | undefined;
    generalAnnouncementChannelId?: string | undefined;
    suggestionChannelId?: string | undefined;
    streamAlertsRoleId?: string | undefined;
    operatorRoleId?: string | undefined;
  };
  permissionOverwritesApplied: number;
  starterMessagesPosted: number;
  starterMessagesSkipped: number;
  complete: boolean;
  needsContinuation: boolean;
  mutationsApplied: number;
  maxMutations?: number | undefined;
};

export type DiscordAnnouncementInput = {
  kind: DiscordAnnouncementKind;
  title?: string;
  detail?: string;
  streamUrl?: string;
  scheduledFor?: string;
  broadcasterName?: string;
  roleId?: string;
};

export type DiscordConfigInput = {
  botToken?: string | undefined;
  guildId?: string | undefined;
  streamAnnouncementChannelId?: string | undefined;
  generalAnnouncementChannelId?: string | undefined;
  streamAlertsRoleId?: string | undefined;
  operatorRoleId?: string | undefined;
  staffRoleId?: string | undefined;
  lockStaffCategory?: boolean | undefined;
};

const viewChannelPermissionBit = "1024";
const discordPermissionBits: Record<DiscordPermissionName, bigint> = {
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  send_messages_in_threads: 1n << 38n,
  read_message_history: 1n << 16n,
  add_reactions: 1n << 6n,
  embed_links: 1n << 14n,
  attach_files: 1n << 15n,
  manage_messages: 1n << 13n,
  connect: 1n << 20n,
  speak: 1n << 21n,
};

export const planDiscordServerSetup = (options: {
  existingChannels: DiscordGuildChannel[];
  existingRoles: DiscordGuildRole[];
  template?: DiscordSetupTemplate;
  includeRoles?: boolean;
  applyPermissions?: boolean;
  postStarterMessages?: boolean;
  existingMessageIds?: Record<string, string>;
  guildId?: string;
  lockStaffCategory?: boolean;
  staffRoleId?: string;
}): DiscordSetupPlan => {
  const template = options.template ?? defaultDiscordSetupTemplate;
  const includeRoles = options.includeRoles ?? false;
  const applyPermissions = options.applyPermissions ?? false;
  const postStarterMessages = options.postStarterMessages ?? false;
  const lockStaffCategory = options.lockStaffCategory ?? false;
  const actions: DiscordSetupAction[] = [];
  const roleIds = new Map<string, string>();
  const channelIds = new Map<string, string>();

  for (const role of template.roles) {
    const existing = findExistingRole(options.existingRoles, role);
    if (existing) {
      roleIds.set(role.id, existing.id);
      actions.push({
        type: "use_existing_role",
        templateId: role.id,
        name: role.name,
        discordId: existing.id,
        detail: `Uses existing Discord role ${role.name}.`,
      });
    } else if (includeRoles) {
      actions.push({
        type: "create_role",
        templateId: role.id,
        name: role.name,
        detail: `Creates Discord role ${role.name}.`,
      });
    } else {
      actions.push({
        type: "skip_role",
        templateId: role.id,
        name: role.name,
        detail:
          "Preset role creation is optional and skipped unless role setup is enabled.",
      });
    }
  }

  for (const channel of template.channels) {
    const parentId = channel.parentId ? channelIds.get(channel.parentId) : null;
    const existing = findExistingChannel(
      options.existingChannels,
      channel,
      parentId,
    );

    if (existing) {
      channelIds.set(channel.id, existing.id);
      actions.push({
        type: "use_existing_channel",
        templateId: channel.id,
        name: channel.name,
        kind: channel.kind,
        discordId: existing.id,
        detail: `Uses existing ${channel.kind} channel ${channel.name}.`,
      });
      continue;
    }

    actions.push({
      type: "create_channel",
      templateId: channel.id,
      name: channel.name,
      kind: channel.kind,
      detail: `Creates ${channel.kind} channel ${channel.name}.`,
    });
  }

  if (applyPermissions) {
    actions.push(
      ...planTemplatePermissionOverwrites({
        template,
        roleIds,
        channelIds,
        includeRoles,
        guildId: options.guildId,
      }),
    );
  }

  if (lockStaffCategory) {
    const staffCategory = template.channels.find(
      (channel) => channel.id === "category-staff",
    );
    if (!options.staffRoleId) {
      actions.push({
        type: "blocked_permission",
        templateId: "category-staff-permissions",
        name: staffCategory?.name ?? "STAFF",
        kind: "category",
        detail:
          "Staff privacy is enabled, but no Staff role ID is saved. Select the role that should see Staff before applying privacy.",
      });
    } else if (options.staffRoleId === options.guildId) {
      actions.push({
        type: "blocked_permission",
        templateId: "category-staff-permissions",
        name: staffCategory?.name ?? "STAFF",
        kind: "category",
        detail:
          "Staff privacy cannot use the @everyone role. Select a dedicated staff/moderator role.",
      });
    } else {
      actions.push({
        type: "apply_permission_overwrite",
        templateId: "category-staff-permissions",
        name: staffCategory?.name ?? "STAFF",
        kind: "category",
        detail:
          "Locks the Staff category from @everyone and allows the selected Staff role to view it.",
      });
    }
  }

  if (postStarterMessages) {
    actions.push(
      ...planStarterMessages({
        template,
        channelIds,
        existingMessageIds: options.existingMessageIds ?? {},
      }),
    );
  }

  return {
    ok: true,
    template: {
      id: template.id,
      name: template.name,
      description: template.description,
    },
    includeRoles,
    applyPermissions,
    postStarterMessages,
    lockStaffCategory,
    actions,
    summary: {
      channelsToCreate: actions.filter(
        (action) => action.type === "create_channel",
      ).length,
      existingChannels: actions.filter(
        (action) => action.type === "use_existing_channel",
      ).length,
      rolesToCreate: actions.filter((action) => action.type === "create_role")
        .length,
      existingRoles: actions.filter(
        (action) => action.type === "use_existing_role",
      ).length,
      skippedRoles: actions.filter((action) => action.type === "skip_role")
        .length,
      permissionOverwrites: actions.filter(
        (action) => action.type === "apply_permission_overwrite",
      ).length,
      blockedPermissions: actions.filter(
        (action) => action.type === "blocked_permission",
      ).length,
      starterMessagesToPost: actions.filter(
        (action) => action.type === "post_starter_message",
      ).length,
      starterMessagesSkipped: actions.filter(
        (action) => action.type === "skip_starter_message",
      ).length,
      starterMessagesBlocked: actions.filter(
        (action) => action.type === "blocked_starter_message",
      ).length,
    },
  };
};

export const previewDiscordSetupTemplate = (
  template = defaultDiscordSetupTemplate,
) =>
  planDiscordServerSetup({
    existingChannels: [],
    existingRoles: [],
    template,
  });

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

export const buildDiscordAnnouncementMessage = (
  input: DiscordAnnouncementInput,
): DiscordCreateMessageInput => {
  const kind = input.kind;
  const roleId = input.roleId
    ? normalizeDiscordSnowflake(input.roleId, "Discord role ID")
    : "";
  const streamUrl = sanitizeOptionalUrl(input.streamUrl, "Stream URL");
  const broadcasterName = sanitizeOptionalText(
    input.broadcasterName,
    "Broadcaster name",
    80,
  );
  const title =
    sanitizeOptionalText(input.title, "Announcement title", 120) ||
    defaultAnnouncementTitle(kind);
  const detail =
    sanitizeOptionalLongText(input.detail, "Announcement detail", 1200) ||
    defaultAnnouncementDetail(kind, broadcasterName, streamUrl);
  const scheduledFor = sanitizeOptionalText(
    input.scheduledFor,
    "Scheduled time",
    120,
  );
  const contentPrefix = roleId && kind === "live" ? `<@&${roleId}> ` : "";
  const content = `${contentPrefix}${title}`.slice(0, 2000);
  const color = {
    live: 0x39d9ff,
    late: 0xf5c542,
    cancelled: 0xf05f66,
    scheduled: 0x8bd17c,
  }[kind];

  const fields = scheduledFor
    ? [{ name: "Time", value: scheduledFor, inline: true }]
    : [];

  return {
    content,
    embeds: [
      {
        title,
        description: detail,
        color,
        url: streamUrl || undefined,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: "VaexCore Console" },
      },
    ],
    allowed_mentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
  };
};

export const sendDiscordAnnouncement = async (options: {
  client: DiscordApiClient;
  channelId: string;
  input: DiscordAnnouncementInput;
}) => {
  const channelId = normalizeDiscordSnowflake(
    options.channelId,
    "Discord announcement channel ID",
  );
  const message = buildDiscordAnnouncementMessage(options.input);
  const result = await options.client.createMessage(channelId, message);
  return { ok: true, message, result };
};

export const normalizeDiscordConfigInput = (
  input: DiscordConfigInput,
): DiscordConfigInput => ({
  botToken: sanitizeOptionalText(input.botToken, "Discord bot token", 240),
  guildId: normalizeOptionalDiscordSnowflake(
    input.guildId,
    "Discord server ID",
  ),
  streamAnnouncementChannelId: normalizeOptionalDiscordSnowflake(
    input.streamAnnouncementChannelId,
    "Discord stream announcement channel ID",
  ),
  generalAnnouncementChannelId: normalizeOptionalDiscordSnowflake(
    input.generalAnnouncementChannelId,
    "Discord general announcement channel ID",
  ),
  streamAlertsRoleId: normalizeOptionalDiscordSnowflake(
    input.streamAlertsRoleId,
    "Discord Stream Alerts role ID",
  ),
  operatorRoleId: normalizeOptionalDiscordSnowflake(
    input.operatorRoleId,
    "Discord operator role ID",
  ),
  staffRoleId: normalizeOptionalDiscordSnowflake(
    input.staffRoleId,
    "Discord staff role ID",
  ),
  lockStaffCategory: Boolean(input.lockStaffCategory),
});

export const normalizeDiscordSnowflake = (value: unknown, field: string) => {
  const id = sanitizeText(value, {
    field,
    maxLength: 32,
    required: true,
  });

  if (!/^\d{5,30}$/.test(id)) {
    throw new SafeInputError(`${field} must be a Discord numeric ID.`);
  }

  return id;
};

const normalizeOptionalDiscordSnowflake = (
  value: unknown,
  field: string,
): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return normalizeDiscordSnowflake(value, field);
};

const planTemplatePermissionOverwrites = (options: {
  template: DiscordSetupTemplate;
  roleIds: Map<string, string>;
  channelIds: Map<string, string>;
  includeRoles: boolean;
  guildId?: string | undefined;
}): DiscordSetupAction[] => {
  const channelTemplates = new Set(
    options.template.channels.map((channel) => channel.id),
  );
  const roleTemplates = new Set(options.template.roles.map((role) => role.id));

  return (options.template.permissionOverwrites ?? []).map((overwrite) => {
    const channelResolvable =
      options.channelIds.has(overwrite.channelId) ||
      channelTemplates.has(overwrite.channelId);
    const roleResolvable =
      overwrite.roleId === "@everyone"
        ? Boolean(options.guildId)
        : options.roleIds.has(overwrite.roleId) ||
          (options.includeRoles && roleTemplates.has(overwrite.roleId));

    if (!channelResolvable || !roleResolvable) {
      return {
        type: "blocked_permission",
        templateId: overwrite.id,
        name: overwrite.id,
        detail: !channelResolvable
          ? `Permission target channel ${overwrite.channelId} is not part of this setup.`
          : `Permission target role ${overwrite.roleId} is not available. Enable preset role creation or save/select an existing role.`,
      };
    }

    return {
      type: "apply_permission_overwrite",
      templateId: overwrite.id,
      name: overwrite.id,
      detail:
        overwrite.detail ??
        `Applies Discord permission overwrite ${overwrite.id}.`,
    };
  });
};

const planStarterMessages = (options: {
  template: DiscordSetupTemplate;
  channelIds: Map<string, string>;
  existingMessageIds: Record<string, string>;
}): DiscordSetupAction[] => {
  const channelTemplates = new Set(
    options.template.channels.map((channel) => channel.id),
  );

  return (options.template.starterMessages ?? []).map((message) => {
    if (options.existingMessageIds[message.id]) {
      return {
        type: "skip_starter_message",
        templateId: message.id,
        name: message.id,
        detail: `Starter message ${message.id} has already been posted.`,
      };
    }
    if (
      !options.channelIds.has(message.channelId) &&
      !channelTemplates.has(message.channelId)
    ) {
      return {
        type: "blocked_starter_message",
        templateId: message.id,
        name: message.id,
        detail: `Starter message target channel ${message.channelId} is not part of this setup.`,
      };
    }
    return {
      type: "post_starter_message",
      templateId: message.id,
      name: message.id,
      detail: `Posts to ${message.channelId}: ${message.content}`,
    };
  });
};

const permissionBitfield = (permissions: DiscordPermissionName[]) =>
  permissions
    .reduce((bits, permission) => bits | discordPermissionBits[permission], 0n)
    .toString();

const channelPermissionOverwriteMatches = (
  channels: DiscordGuildChannel[],
  channelId: string,
  overwriteId: string,
  input: DiscordPermissionOverwriteInput,
) => {
  const existing = channels
    .find((channel) => channel.id === channelId)
    ?.permission_overwrites?.find((overwrite) => overwrite.id === overwriteId);
  return (
    existing?.type === input.type &&
    bitfieldsEqual(existing.allow, input.allow) &&
    bitfieldsEqual(existing.deny, input.deny)
  );
};

const recordChannelPermissionOverwrite = (
  channels: DiscordGuildChannel[],
  channelId: string,
  overwriteId: string,
  input: DiscordPermissionOverwriteInput,
) => {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) return;
  const overwrites = channel.permission_overwrites ?? [];
  const next = {
    id: overwriteId,
    type: input.type,
    allow: input.allow,
    deny: input.deny,
  };
  const index = overwrites.findIndex(
    (overwrite) => overwrite.id === overwriteId,
  );
  if (index >= 0) {
    overwrites[index] = next;
  } else {
    overwrites.push(next);
  }
  channel.permission_overwrites = overwrites;
};

const bitfieldsEqual = (left: string | undefined, right: string | undefined) =>
  BigInt(left ?? "0") === BigInt(right ?? "0");

const findExistingRole = (
  roles: DiscordGuildRole[],
  template: DiscordSetupRoleTemplate,
) =>
  roles.find(
    (role) => normalizeRoleName(role.name) === normalizeRoleName(template.name),
  );

const findExistingChannel = (
  channels: DiscordGuildChannel[],
  template: DiscordSetupChannelTemplate,
  parentDiscordId?: string | null,
) => {
  const expectedType = discordChannelTypeCodes[template.kind];
  const expectedName = normalizeChannelName(template.name);
  const matches = channels.filter(
    (channel) =>
      discordChannelMatchesTemplateType(channel.type, expectedType, template) &&
      normalizeChannelName(channel.name) === expectedName,
  );

  if (!parentDiscordId) {
    return matches[0];
  }

  return (
    matches.find((channel) => channel.parent_id === parentDiscordId) ??
    matches[0]
  );
};

const discordChannelMatchesTemplateType = (
  actualType: number,
  expectedType: number,
  template: DiscordSetupChannelTemplate,
) =>
  actualType === expectedType ||
  (template.id === "announcements" &&
    template.kind === "text" &&
    actualType === 5);

const normalizeRoleName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

const normalizeChannelName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const defaultAnnouncementTitle = (kind: DiscordAnnouncementKind) => {
  if (kind === "live") return "Stream is live";
  if (kind === "late") return "Stream is running late";
  if (kind === "cancelled") return "Stream cancelled";
  return "Stream scheduled";
};

const defaultAnnouncementDetail = (
  kind: DiscordAnnouncementKind,
  broadcasterName?: string,
  streamUrl?: string,
) => {
  const channel = broadcasterName || "the channel";
  if (kind === "live") {
    return streamUrl
      ? `${channel} is live now: ${streamUrl}`
      : `${channel} is live now.`;
  }
  if (kind === "late") {
    return `${channel} is running late. A new start notice will be posted when the stream is ready.`;
  }
  if (kind === "cancelled") {
    return `${channel}'s planned stream has been cancelled.`;
  }
  return `${channel} has a stream scheduled.`;
};

const sanitizeOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return sanitizeText(value, {
    field,
    maxLength,
    required: true,
  });
};

const sanitizeOptionalLongText = (
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return sanitizeText(value, {
    field,
    maxLength,
    allowNewlines: true,
    required: true,
  });
};

const sanitizeOptionalUrl = (value: unknown, field: string) => {
  const text = sanitizeOptionalText(value, field, 300);
  if (!text) {
    return undefined;
  }

  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SafeInputError(`${field} must be an http or https URL.`);
  }

  return url.toString();
};

export const normalizeOptionalPositiveInteger = (
  value: unknown,
  field: string,
  max: number,
) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parseSafeInteger(value, { field, min: 1, max });
};
