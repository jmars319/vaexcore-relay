import type {
  DiscordGuildChannel,
  DiscordGuildRole,
  DiscordPermissionOverwriteInput,
} from "./client";
import type { DiscordSetupAction } from "./setup-types";
import {
  discordChannelTypeCodes,
  type DiscordPermissionName,
  type DiscordSetupChannelTemplate,
  type DiscordSetupPermissionOverwriteTemplate,
  type DiscordSetupRoleTemplate,
  type DiscordSetupTemplate,
} from "./templates";

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

export const planTemplatePermissionOverwrites = (options: {
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

export const planStarterMessages = (options: {
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

export const permissionBitfield = (permissions: DiscordPermissionName[]) =>
  permissions
    .reduce((bits, permission) => bits | discordPermissionBits[permission], 0n)
    .toString();

export const channelPermissionOverwriteMatches = (
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

export const recordChannelPermissionOverwrite = (
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

export const bitfieldsEqual = (
  left: string | undefined,
  right: string | undefined,
) => BigInt(left ?? "0") === BigInt(right ?? "0");

export const findExistingRole = (
  roles: DiscordGuildRole[],
  template: DiscordSetupRoleTemplate,
) =>
  roles.find(
    (role) => normalizeRoleName(role.name) === normalizeRoleName(template.name),
  );

export const findExistingChannel = (
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

export const discordChannelMatchesTemplateType = (
  actualType: number,
  expectedType: number,
  template: DiscordSetupChannelTemplate,
) =>
  actualType === expectedType ||
  (template.id === "announcements" &&
    template.kind === "text" &&
    actualType === 5);

export const normalizeRoleName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

export const normalizeChannelName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export { viewChannelPermissionBit };
