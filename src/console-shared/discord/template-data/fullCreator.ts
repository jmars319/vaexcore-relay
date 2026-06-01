import type {
  DiscordPermissionName,
  DiscordSetupPermissionOverwriteTemplate,
  DiscordSetupRoleTemplate,
  DiscordSetupStarterMessageTemplate,
  DiscordSetupTemplate,
} from "./types";

const fullCreatorRoles: DiscordSetupRoleTemplate[] = [
  {
    id: "creator",
    name: "Creator",
    color: 0xf05f66,
    hoist: true,
  },
  {
    id: "staff",
    name: "Staff",
    color: 0xf5c542,
    hoist: true,
  },
  {
    id: "moderator",
    name: "Moderator",
    color: 0x8bd17c,
    hoist: true,
  },
  {
    id: "vaexcore-operator",
    name: "VaexCore Operator",
    color: 0x39d9ff,
    hoist: true,
  },
  {
    id: "event-host",
    name: "Event Host",
    color: 0xff9f43,
    hoist: false,
  },
  {
    id: "collaborator",
    name: "Collaborator",
    color: 0xb58cff,
    hoist: false,
  },
  {
    id: "vip",
    name: "VIP",
    color: 0xff78c4,
    hoist: false,
  },
  {
    id: "subscriber",
    name: "Subscriber",
    color: 0x6ee7b7,
    hoist: false,
  },
  {
    id: "member",
    name: "Member",
    color: 0x8aa4ff,
    hoist: false,
  },
  {
    id: "stream-alerts",
    name: "Stream Alerts",
    color: 0x39d9ff,
    mentionable: true,
    hoist: false,
  },
  {
    id: "clips-ping",
    name: "Clips Ping",
    color: 0xa7f3d0,
    mentionable: true,
    hoist: false,
  },
  {
    id: "giveaway-ping",
    name: "Giveaway Ping",
    color: 0xfde68a,
    mentionable: true,
    hoist: false,
  },
  {
    id: "muted",
    name: "Muted",
    color: 0x6b7280,
    hoist: false,
  },
];

const staffVisibleRoleIds = [
  "creator",
  "staff",
  "moderator",
  "vaexcore-operator",
];
const restrictedWriterRoleIds = [
  "creator",
  "staff",
  "moderator",
  "vaexcore-operator",
  "event-host",
];
const restrictedWriterChannelIds = [
  "rules",
  "announcements",
  "roles-and-alerts",
  "live-now",
];
const communityWritableChannelIds = [
  "suggestions",
  "general",
  "stream-chat",
  "clips-and-highlights",
  "game-chat",
  "media-share",
  "off-topic",
  "polls-and-giveaways",
  "content-ideas",
  "gear-and-setups",
  "collabs",
];
const voiceChannelIds = [
  "voice-lobby",
  "voice-gaming",
  "voice-gaming-two",
  "voice-stream-waiting-room",
  "voice-afk",
];
const staffChannelIds = [
  "category-staff",
  "staff-chat",
  "mod-log",
  "content-planning",
  "incident-notes",
];
const permissions = (
  ...items: DiscordPermissionName[]
): DiscordPermissionName[] => items;

const fullCreatorPermissionOverwrites: DiscordSetupPermissionOverwriteTemplate[] =
  [
    ...staffChannelIds.flatMap((channelId) => [
      {
        id: `${channelId}-hide-everyone`,
        channelId,
        roleId: "@everyone",
        deny: permissions("view_channel"),
        detail: "Hide Staff operations from regular members.",
      },
      ...staffVisibleRoleIds.map((roleId) => ({
        id: `${channelId}-allow-${roleId}`,
        channelId,
        roleId,
        allow: permissions(
          "view_channel",
          "read_message_history",
          "send_messages",
          "send_messages_in_threads",
          "embed_links",
          "attach_files",
          "manage_messages",
        ),
        detail: "Allow staff operations access.",
      })),
    ]),
    ...restrictedWriterChannelIds.flatMap((channelId) => [
      {
        id: `${channelId}-read-only-everyone`,
        channelId,
        roleId: "@everyone",
        allow: permissions("view_channel", "read_message_history"),
        deny: permissions("send_messages", "send_messages_in_threads"),
        detail:
          "Keep operations announcement channels readable but staff-writable.",
      },
      ...restrictedWriterRoleIds.map((roleId) => ({
        id: `${channelId}-write-${roleId}`,
        channelId,
        roleId,
        allow: permissions(
          "view_channel",
          "read_message_history",
          "send_messages",
          "send_messages_in_threads",
          "embed_links",
          "attach_files",
        ),
        detail: "Allow operations roles to write here.",
      })),
    ]),
    ...communityWritableChannelIds.map((channelId) => ({
      id: `${channelId}-muted-deny`,
      channelId,
      roleId: "muted",
      deny: permissions(
        "send_messages",
        "send_messages_in_threads",
        "add_reactions",
      ),
      detail: "Prevent muted members from writing in community channels.",
    })),
    ...voiceChannelIds.map((channelId) => ({
      id: `${channelId}-muted-voice-deny`,
      channelId,
      roleId: "muted",
      deny: permissions("speak"),
      detail: "Prevent muted members from speaking in voice channels.",
    })),
  ];

const fullCreatorStarterMessages: DiscordSetupStarterMessageTemplate[] = [
  {
    id: "welcome",
    channelId: "welcome",
    content:
      "Welcome to the server. Start with the rules, choose the alerts you want, and use the stream channels for live updates, clips, suggestions, and community events.",
  },
  {
    id: "rules",
    channelId: "rules",
    content:
      "Baseline rules: be respectful, keep chat readable, avoid harassment or hate, do not spam, keep spoilers marked, and follow staff guidance during live events.",
  },
  {
    id: "roles-and-alerts",
    channelId: "roles-and-alerts",
    content:
      "Alert roles available for setup: Stream Alerts for live notices, Clips Ping for highlight calls, and Giveaway Ping for community giveaways. Staff can assign or replace these with your preferred role-menu workflow.",
  },
  {
    id: "live-now",
    channelId: "live-now",
    content:
      "Stream announcements will appear here. VaexCore can queue live, late, cancelled, and scheduled notices for operator review.",
  },
  {
    id: "suggestions",
    channelId: "suggestions",
    content:
      "Use /suggest to send stream ideas, game requests, segment ideas, and community improvements into VaexCore Console for review.",
  },
  {
    id: "schedule",
    channelId: "schedule",
    content:
      "Post upcoming streams and event times here. VaexCore scheduled notices can point the community back to this channel.",
  },
  {
    id: "staff-chat",
    channelId: "staff-chat",
    content:
      "Private staff coordination lives here. Use it for stream-day notes, moderation handoffs, event prep, and Console action review.",
  },
  {
    id: "mod-log",
    channelId: "mod-log",
    content:
      "Use this channel for moderation notes and follow-up records. Keep private details concise and avoid posting tokens, credentials, or personal data.",
  },
];

export const fullCreatorCommunityDiscordTemplate: DiscordSetupTemplate = {
  schemaVersion: 1,
  id: "full-creator-community",
  name: "Full Creator Server",
  description:
    "A complete creator Discord layout with onboarding, live stream operations, community rooms, content planning, voice, and staff coordination.",
  recommendedFor:
    "Creators who want Console to build the main server structure in one pass before trimming or renaming channels for their community.",
  roles: fullCreatorRoles,
  channels: [
    { id: "category-start-here", name: "START HERE", kind: "category" },
    {
      id: "welcome",
      name: "welcome",
      kind: "text",
      parentId: "category-start-here",
      topic: "New member landing page and server orientation.",
    },
    {
      id: "rules",
      name: "rules",
      kind: "text",
      parentId: "category-start-here",
      topic: "Server rules and community expectations.",
    },
    {
      id: "announcements",
      name: "announcements",
      kind: "text",
      parentId: "category-start-here",
      topic: "General community updates and creator notices.",
    },
    {
      id: "roles-and-alerts",
      name: "roles-and-alerts",
      kind: "text",
      parentId: "category-start-here",
      topic: "Alert role notes and opt-in instructions.",
    },
    { id: "category-stream", name: "STREAM", kind: "category" },
    {
      id: "live-now",
      name: "live-now",
      kind: "text",
      parentId: "category-stream",
      topic: "Stream start, late, cancelled, and schedule notices.",
    },
    {
      id: "schedule",
      name: "schedule",
      kind: "text",
      parentId: "category-stream",
      topic: "Upcoming stream schedule and changes.",
    },
    {
      id: "stream-chat",
      name: "stream-chat",
      kind: "text",
      parentId: "category-stream",
      topic:
        "Live stream chat spillover, watch-along chatter, and post-stream discussion.",
    },
    {
      id: "clips-and-highlights",
      name: "clips-and-highlights",
      kind: "text",
      parentId: "category-stream",
      topic: "Clips, highlights, and stream moments.",
    },
    {
      id: "suggestions",
      name: "suggestions",
      kind: "text",
      parentId: "category-stream",
      topic: "Community suggestions for streams, games, and segments.",
    },
    { id: "category-community", name: "COMMUNITY", kind: "category" },
    {
      id: "general",
      name: "general",
      kind: "text",
      parentId: "category-community",
      topic: "Default community chat.",
    },
    {
      id: "game-chat",
      name: "game-chat",
      kind: "text",
      parentId: "category-community",
      topic: "Game-specific chat, queue talk, and party coordination.",
    },
    {
      id: "media-share",
      name: "media-share",
      kind: "text",
      parentId: "category-community",
      topic: "Screenshots, art, links, and community media.",
    },
    {
      id: "off-topic",
      name: "off-topic",
      kind: "text",
      parentId: "category-community",
      topic: "Casual community conversation that does not fit the main chat.",
    },
    {
      id: "polls-and-giveaways",
      name: "polls-and-giveaways",
      kind: "text",
      parentId: "category-community",
      topic:
        "Community polls, giveaway notices, and event participation prompts.",
    },
    { id: "category-creator-hub", name: "CREATOR HUB", kind: "category" },
    {
      id: "content-ideas",
      name: "content-ideas",
      kind: "text",
      parentId: "category-creator-hub",
      topic: "Stream, video, clip, and community event ideas.",
    },
    {
      id: "gear-and-setups",
      name: "gear-and-setups",
      kind: "text",
      parentId: "category-creator-hub",
      topic: "Streaming setups, gear, software, and workflow notes.",
    },
    {
      id: "collabs",
      name: "collabs",
      kind: "text",
      parentId: "category-creator-hub",
      topic: "Collaboration ideas, guest planning, and creator networking.",
    },
    { id: "category-voice", name: "VOICE", kind: "category" },
    {
      id: "voice-lobby",
      name: "Lobby",
      kind: "voice",
      parentId: "category-voice",
    },
    {
      id: "voice-gaming",
      name: "Gaming",
      kind: "voice",
      parentId: "category-voice",
      userLimit: 10,
    },
    {
      id: "voice-gaming-two",
      name: "Gaming 2",
      kind: "voice",
      parentId: "category-voice",
      userLimit: 10,
    },
    {
      id: "voice-stream-waiting-room",
      name: "Stream Waiting Room",
      kind: "voice",
      parentId: "category-voice",
      userLimit: 8,
    },
    {
      id: "voice-afk",
      name: "AFK",
      kind: "voice",
      parentId: "category-voice",
    },
    { id: "category-staff", name: "STAFF", kind: "category" },
    {
      id: "staff-chat",
      name: "staff-chat",
      kind: "text",
      parentId: "category-staff",
      topic:
        "Private staff coordination for stream-day notes, moderation handoffs, event prep, and Console action review. Review Discord permissions after setup.",
    },
    {
      id: "mod-log",
      name: "mod-log",
      kind: "text",
      parentId: "category-staff",
      topic: "Moderation notes and VaexCore community operations logs.",
    },
    {
      id: "content-planning",
      name: "content-planning",
      kind: "text",
      parentId: "category-staff",
      topic: "Private stream and content planning for staff.",
    },
    {
      id: "incident-notes",
      name: "incident-notes",
      kind: "text",
      parentId: "category-staff",
      topic: "Private moderation incident notes and follow-up tracking.",
    },
  ],
  permissionOverwrites: fullCreatorPermissionOverwrites,
  starterMessages: fullCreatorStarterMessages,
  postStarterMessagesByDefault: true,
  recommended: {
    streamAnnouncementChannelId: "live-now",
    generalAnnouncementChannelId: "announcements",
    suggestionChannelId: "suggestions",
    streamAlertsRoleId: "stream-alerts",
    operatorRoleId: "vaexcore-operator",
    memberRoleId: "member",
    mutedRoleId: "muted",
  },
};
