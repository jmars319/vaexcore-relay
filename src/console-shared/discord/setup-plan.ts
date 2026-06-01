import {
  defaultDiscordSetupTemplate,
  type DiscordSetupTemplate,
} from "./templates";
import type { DiscordGuildChannel, DiscordGuildRole } from "./client";
import type { DiscordSetupAction, DiscordSetupPlan } from "./setup-types";
import {
  findExistingChannel,
  findExistingRole,
  planStarterMessages,
  planTemplatePermissionOverwrites,
} from "./setup-helpers";

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
