import type {
  DiscordCreateMessageInput,
  DiscordGuildChannel,
  DiscordGuildRole,
} from "./client";
import type {
  DiscordAnnouncementKind,
  DiscordChannelKind,
  DiscordSetupTemplate,
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
