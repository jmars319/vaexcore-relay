import type { DiscordSetupTemplate } from "./types";

export const leanLiveAlertsDiscordTemplate: DiscordSetupTemplate = {
  schemaVersion: 1,
  id: "lean-live-alerts",
  name: "Lean Live Alerts",
  description:
    "A compact setup for existing servers that only need live notices, suggestions, basic community chat, voice, and staff review.",
  recommendedFor:
    "Creators adding VaexCore to an existing Discord without creating a large new channel tree.",
  roles: [
    {
      id: "stream-alerts",
      name: "Stream Alerts",
      color: 0x39d9ff,
      mentionable: true,
      hoist: false,
    },
  ],
  channels: [
    { id: "category-start-here", name: "START HERE", kind: "category" },
    {
      id: "welcome",
      name: "welcome",
      kind: "text",
      parentId: "category-start-here",
      topic: "Short server orientation and useful links.",
    },
    {
      id: "rules",
      name: "rules",
      kind: "text",
      parentId: "category-start-here",
      topic: "Server rules and community expectations.",
    },
    { id: "category-stream", name: "STREAM", kind: "category" },
    {
      id: "announcements",
      name: "announcements",
      kind: "text",
      parentId: "category-stream",
      topic: "General creator notices and updates.",
    },
    {
      id: "live-now",
      name: "live-now",
      kind: "text",
      parentId: "category-stream",
      topic: "Stream start, late, cancelled, and schedule notices.",
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
    { id: "category-voice", name: "VOICE", kind: "category" },
    {
      id: "voice-lobby",
      name: "Lobby",
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
        "Private staff coordination for stream-day notes, moderation handoffs, event prep, and Console action review.",
    },
    {
      id: "mod-log",
      name: "mod-log",
      kind: "text",
      parentId: "category-staff",
      topic: "Moderation notes and VaexCore community operations logs.",
    },
  ],
  recommended: {
    streamAnnouncementChannelId: "live-now",
    generalAnnouncementChannelId: "announcements",
    suggestionChannelId: "suggestions",
    streamAlertsRoleId: "stream-alerts",
  },
};
