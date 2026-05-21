import { hexToBytes } from "./crypto";

const discordApiBase = "https://discord.com/api/v10";
const discordAuthorizeBase = "https://discord.com/oauth2/authorize";
const textEncoder = new TextEncoder();

export const discordInteractionType = {
  ping: 1,
  applicationCommand: 2,
} as const;

export const discordInteractionResponseType = {
  pong: 1,
  channelMessageWithSource: 4,
} as const;

export const discordMessageFlags = {
  ephemeral: 1 << 6,
} as const;

const discordCommandType = {
  chatInput: 1,
} as const;

const discordOptionType = {
  string: 3,
} as const;

const discordPermission = {
  administrator: 1n << 3n,
  manageChannels: 1n << 4n,
  manageGuild: 1n << 5n,
  addReactions: 1n << 6n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  readMessageHistory: 1n << 16n,
  manageRoles: 1n << 28n,
} as const;

const discordHostedInstallPermissionBits =
  discordPermission.viewChannel |
  discordPermission.manageChannels |
  discordPermission.manageRoles |
  discordPermission.sendMessages |
  discordPermission.embedLinks |
  discordPermission.readMessageHistory |
  discordPermission.addReactions;

export type DiscordInteractionOption = {
  name?: string;
  type?: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
};

export type DiscordUser = {
  id?: string;
  username?: string;
  global_name?: string | null;
};

export type DiscordInteraction = {
  id?: string;
  application_id?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: DiscordUser;
    roles?: string[];
    permissions?: string;
  };
  user?: DiscordUser;
  data?: {
    name?: string;
    type?: number;
    options?: DiscordInteractionOption[];
  };
};

export type DiscordApplicationCommand = {
  type: number;
  name: string;
  description: string;
  options?: Array<{
    type: number;
    name: string;
    description: string;
    required?: boolean;
  }>;
};

export type DiscordOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  guild?: {
    id?: string;
    name?: string;
  };
};

export const discordHostedInstallPermissions = () =>
  discordHostedInstallPermissionBits.toString();

export const buildDiscordInstallAuthorizeUrl = (input: {
  applicationId: string;
  redirectUri: string;
  state: string;
}) => {
  const url = new URL(discordAuthorizeBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.applicationId);
  url.searchParams.set("scope", "bot applications.commands identify");
  url.searchParams.set("permissions", discordHostedInstallPermissions());
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("integration_type", "0");
  return url.toString();
};

export const exchangeDiscordOAuthCode = async (input: {
  applicationId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}) => {
  const body = new URLSearchParams({
    client_id: input.applicationId,
    client_secret: input.clientSecret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const response = await (input.fetchImpl ?? fetch)(
    `${discordApiBase}/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const token = (await response
    .json()
    .catch(() => null)) as DiscordOAuthTokenResponse | null;
  return { response, token };
};

export const revokeDiscordOAuthToken = async (input: {
  applicationId: string;
  clientSecret: string;
  token: string;
  fetchImpl?: typeof fetch;
}) => {
  const body = new URLSearchParams({
    client_id: input.applicationId,
    client_secret: input.clientSecret,
    token: input.token,
  });
  return (input.fetchImpl ?? fetch)(`${discordApiBase}/oauth2/token/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
};

export type DiscordQueuedEvent = {
  id: string;
  commandName: string;
  kind: "suggestion" | "announcement" | "status" | "unknown";
  userId: string;
  username: string;
  guildId: string;
  channelId: string;
  options: Record<string, string | number | boolean>;
  allowed: boolean;
  receivedAt: string;
};

export const discordApplicationCommands = (): DiscordApplicationCommand[] => [
  {
    type: discordCommandType.chatInput,
    name: "suggest",
    description: "Send a stream or community suggestion to VaexCore Console.",
    options: [
      {
        type: discordOptionType.string,
        name: "text",
        description: "Suggestion text",
        required: true,
      },
    ],
  },
  {
    type: discordCommandType.chatInput,
    name: "live",
    description: "Queue a stream live announcement for operator review.",
    options: announcementOptions(),
  },
  {
    type: discordCommandType.chatInput,
    name: "late",
    description: "Queue a stream late announcement for operator review.",
    options: announcementOptions(),
  },
  {
    type: discordCommandType.chatInput,
    name: "cancelled",
    description: "Queue a stream cancelled announcement for operator review.",
    options: announcementOptions(),
  },
  {
    type: discordCommandType.chatInput,
    name: "scheduled",
    description: "Queue a scheduled stream announcement for operator review.",
    options: [
      {
        type: discordOptionType.string,
        name: "scheduled_for",
        description: "Scheduled start time",
        required: false,
      },
      ...announcementOptions(),
    ],
  },
  {
    type: discordCommandType.chatInput,
    name: "setup-status",
    description: "Show VaexCore Discord bot setup status.",
  },
];

const announcementOptions = () => [
  {
    type: discordOptionType.string,
    name: "title",
    description: "Announcement title",
    required: false,
  },
  {
    type: discordOptionType.string,
    name: "detail",
    description: "Announcement detail",
    required: false,
  },
  {
    type: discordOptionType.string,
    name: "url",
    description: "Stream URL",
    required: false,
  },
];

export const verifyDiscordInteractionSignature = async (input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  body: string;
}) => {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(input.publicKey),
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(input.signature),
      textEncoder.encode(`${input.timestamp}${input.body}`),
    );
  } catch {
    return false;
  }
};

export const registerDiscordApplicationCommands = async (input: {
  applicationId: string;
  botToken: string;
  guildId?: string | undefined;
  fetchImpl?: typeof fetch;
}) => {
  const endpoint = input.guildId
    ? `${discordApiBase}/applications/${input.applicationId}/guilds/${input.guildId}/commands`
    : `${discordApiBase}/applications/${input.applicationId}/commands`;
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(discordApplicationCommands()),
  });
  const body = await response.json().catch(() => null);
  return {
    response,
    body,
    scope: input.guildId ? "guild" : "global",
  };
};

export const discordInteractionUser = (interaction: DiscordInteraction) => {
  const user = interaction.member?.user ?? interaction.user ?? {};
  return {
    id: user.id ?? "unknown",
    username: (user.global_name || user.username || "Discord user").slice(
      0,
      80,
    ),
  };
};

export const discordOptionRecord = (interaction: DiscordInteraction) => {
  const output: Record<string, string | number | boolean> = {};
  for (const option of interaction.data?.options ?? []) {
    if (
      typeof option.name === "string" &&
      (typeof option.value === "string" ||
        typeof option.value === "number" ||
        typeof option.value === "boolean")
    ) {
      output[option.name] =
        typeof option.value === "string"
          ? option.value.slice(0, 1_000)
          : option.value;
    }
  }
  return output;
};

export const discordOptionString = (
  interaction: DiscordInteraction,
  name: string,
  maxLength: number,
) => {
  const value = discordOptionRecord(interaction)[name];
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : "";
};

export const discordCommandKind = (
  commandName: string,
): DiscordQueuedEvent["kind"] => {
  if (commandName === "suggest") return "suggestion";
  if (commandName === "setup-status") return "status";
  if (isDiscordAnnouncementCommand(commandName)) return "announcement";
  return "unknown";
};

export const isDiscordAnnouncementCommand = (commandName: string) =>
  ["live", "late", "cancelled", "scheduled"].includes(commandName);

export const hasDiscordOperatorPermission = (
  interaction: DiscordInteraction,
  operatorRoleId?: string,
) => {
  if (
    operatorRoleId &&
    interaction.member?.roles?.some((roleId) => roleId === operatorRoleId)
  ) {
    return true;
  }
  const rawPermissions = interaction.member?.permissions;
  if (!rawPermissions || !/^\d+$/.test(rawPermissions)) {
    return false;
  }
  const permissions = BigInt(rawPermissions);
  return (
    (permissions & discordPermission.administrator) !== 0n ||
    (permissions & discordPermission.manageGuild) !== 0n
  );
};

export const discordInteractionMatchesConfiguredGuild = (
  interaction: DiscordInteraction,
  configuredGuildId?: string,
) => !configuredGuildId || interaction.guild_id === configuredGuildId;

export const discordEphemeralResponse = (content: string) => ({
  type: discordInteractionResponseType.channelMessageWithSource,
  data: {
    content: content.slice(0, 2_000),
    flags: discordMessageFlags.ephemeral,
    allowed_mentions: { parse: [] },
  },
});
