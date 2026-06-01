import {
  SafeInputError,
  parseSafeInteger,
  sanitizeText,
} from "../core/security";
import type { DiscordConfigInput } from "./setup-types";

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

export const sanitizeOptionalText = (
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

export const sanitizeOptionalLongText = (
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

export const sanitizeOptionalUrl = (value: unknown, field: string) => {
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
