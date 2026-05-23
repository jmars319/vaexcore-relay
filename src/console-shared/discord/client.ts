import { redactSecretText } from "../core/security";

export type DiscordChannelType = 0 | 2 | 4;

export type DiscordGuildChannel = {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  permission_overwrites?: DiscordPermissionOverwrite[];
};

export type DiscordGuildRole = {
  id: string;
  name: string;
  color?: number;
  hoist?: boolean;
  managed?: boolean;
  mentionable?: boolean;
};

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  content?: string;
  timestamp?: string;
};

export type DiscordPermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

export type DiscordCreateChannelInput = {
  name: string;
  type: DiscordChannelType;
  parent_id?: string | undefined;
  topic?: string | undefined;
  bitrate?: number | undefined;
  user_limit?: number | undefined;
  nsfw?: boolean | undefined;
};

export type DiscordCreateRoleInput = {
  name: string;
  permissions?: string | undefined;
  color?: number | undefined;
  hoist?: boolean | undefined;
  mentionable?: boolean | undefined;
};

export type DiscordCreateMessageInput = {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  allowed_mentions?: Record<string, unknown>;
};

export type DiscordPermissionOverwriteInput = {
  type: 0 | 1;
  allow: string;
  deny: string;
};

export type DiscordApiClientOptions = {
  botToken: string;
  apiBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export class DiscordHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "DiscordHttpError";
    this.status = status;
    this.body = body;
  }
}

export class DiscordApiClient {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DiscordApiClientOptions) {
    this.botToken = options.botToken;
    this.apiBaseUrl =
      options.apiBaseUrl?.replace(/\/+$/, "") ?? "https://discord.com/api/v10";
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  getCurrentUser() {
    return this.request<DiscordUser>("/users/@me");
  }

  listGuildChannels(guildId: string) {
    return this.request<DiscordGuildChannel[]>(
      `/guilds/${encodeURIComponent(guildId)}/channels`,
    );
  }

  createGuildChannel(guildId: string, input: DiscordCreateChannelInput) {
    return this.request<DiscordGuildChannel>(
      `/guilds/${encodeURIComponent(guildId)}/channels`,
      {
        method: "POST",
        body: cleanJson(input),
      },
    );
  }

  listGuildRoles(guildId: string) {
    return this.request<DiscordGuildRole[]>(
      `/guilds/${encodeURIComponent(guildId)}/roles`,
    );
  }

  createGuildRole(guildId: string, input: DiscordCreateRoleInput) {
    return this.request<DiscordGuildRole>(
      `/guilds/${encodeURIComponent(guildId)}/roles`,
      {
        method: "POST",
        body: cleanJson(input),
      },
    );
  }

  createMessage(channelId: string, input: DiscordCreateMessageInput) {
    return this.request<DiscordMessage>(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        body: cleanJson(input),
      },
    );
  }

  setChannelPermissionOverwrite(
    channelId: string,
    overwriteId: string,
    input: DiscordPermissionOverwriteInput,
  ) {
    return this.request<void>(
      `/channels/${encodeURIComponent(channelId)}/permissions/${encodeURIComponent(overwriteId)}`,
      {
        method: "PUT",
        body: cleanJson(input),
      },
    );
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: string } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
        "User-Agent":
          "VaexCore Console (https://github.com/jmars319/vaexcore-console)",
      },
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
    });

    if (!response.ok) {
      const body = await response.text();
      const message = discordErrorMessage(response.status, path, body);
      throw new DiscordHttpError(message, response.status, body);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

const cleanJson = (value: Record<string, unknown>) =>
  JSON.stringify(stripUndefined(value));

const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }

  return value;
};

const discordErrorMessage = (status: number, path: string, body: string) => {
  const redactedBody = redactSecretText(body).slice(0, 500);

  if (status === 401) {
    return "Discord rejected the bot token. Recheck the saved Discord bot token.";
  }

  if (status === 403) {
    return `Discord denied the request at ${path}. Confirm the bot is in the server and has the required role/channel permissions. ${redactedBody}`;
  }

  if (status === 429) {
    return `Discord rate-limited this request. Wait and retry. ${redactedBody}`;
  }

  return `Discord API request failed (${status}) at ${path}: ${redactedBody}`;
};
