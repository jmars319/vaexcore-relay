export const discordChannelTypeCodes = {
  text: 0,
  voice: 2,
  category: 4,
} as const;

export type DiscordChannelKind = keyof typeof discordChannelTypeCodes;

export type DiscordSetupChannelTemplate = {
  id: string;
  name: string;
  kind: DiscordChannelKind;
  parentId?: string;
  topic?: string;
  bitrate?: number;
  userLimit?: number;
  nsfw?: boolean;
};

export type DiscordSetupRoleTemplate = {
  id: string;
  name: string;
  permissions?: DiscordPermissionName[];
  color?: number;
  mentionable?: boolean;
  hoist?: boolean;
};

export type DiscordPermissionName =
  | "view_channel"
  | "send_messages"
  | "send_messages_in_threads"
  | "read_message_history"
  | "add_reactions"
  | "embed_links"
  | "attach_files"
  | "manage_messages"
  | "connect"
  | "speak";

export type DiscordSetupPermissionOverwriteTemplate = {
  id: string;
  channelId: string;
  roleId: string;
  allow?: DiscordPermissionName[];
  deny?: DiscordPermissionName[];
  detail?: string;
};

export type DiscordSetupStarterMessageTemplate = {
  id: string;
  channelId: string;
  content: string;
};

export type DiscordSetupTemplate = {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  recommendedFor?: string;
  roles: DiscordSetupRoleTemplate[];
  channels: DiscordSetupChannelTemplate[];
  permissionOverwrites?: DiscordSetupPermissionOverwriteTemplate[];
  starterMessages?: DiscordSetupStarterMessageTemplate[];
  postStarterMessagesByDefault?: boolean;
  recommended: {
    streamAnnouncementChannelId: string;
    generalAnnouncementChannelId: string;
    suggestionChannelId: string;
    streamAlertsRoleId: string;
    operatorRoleId?: string;
    memberRoleId?: string;
    mutedRoleId?: string;
  };
};

export const discordAnnouncementKinds = [
  "live",
  "late",
  "cancelled",
  "scheduled",
] as const;

export type DiscordAnnouncementKind = (typeof discordAnnouncementKinds)[number];
