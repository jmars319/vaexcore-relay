import type { DiscordApiClient, DiscordCreateMessageInput } from "./client";
import type { DiscordAnnouncementInput } from "./setup-types";
import type { DiscordAnnouncementKind } from "./templates";
import {
  normalizeDiscordSnowflake,
  sanitizeOptionalLongText,
  sanitizeOptionalText,
  sanitizeOptionalUrl,
} from "./setup-normalize";

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
