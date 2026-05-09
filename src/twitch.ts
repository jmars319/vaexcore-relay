import {
  decryptText,
  encryptText,
  hmacSha256Hex,
  constantTimeEqual,
} from "./crypto";
import {
  type OAuthGrantKind,
  type OAuthGrantRow,
  type RelayChatEvent,
  type TwitchEventSubEnvelope,
  type TwitchTokenResponse,
  type TwitchTokenValidation,
  requiredBotScopes,
  requiredBroadcasterScopes,
} from "./types";

const twitchApiBase = "https://api.twitch.tv/helix";
const twitchIdBase = "https://id.twitch.tv/oauth2";

export const scopesForGrant = (kind: OAuthGrantKind) =>
  kind === "bot" ? [...requiredBotScopes] : [...requiredBroadcasterScopes];

export const missingScopes = (scopes: string[], required: readonly string[]) =>
  required.filter((scope) => !scopes.includes(scope));

export const buildTwitchAuthorizeUrl = (input: {
  clientId: string;
  redirectUri: string;
  state: string;
  kind: OAuthGrantKind;
}) => {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    scope: scopesForGrant(input.kind).join(" "),
    force_verify: "true",
  });
  return `${twitchIdBase}/authorize?${params}`;
};

export const exchangeTwitchCode = async (input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}) => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await (input.fetchImpl ?? fetch)(`${twitchIdBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Twitch OAuth code exchange failed: ${response.status}`);
  }
  return (await response.json()) as TwitchTokenResponse;
};

export const getAppAccessToken = async (input: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}) => {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "client_credentials",
  });
  const response = await (input.fetchImpl ?? fetch)(`${twitchIdBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Twitch app token request failed: ${response.status}`);
  }
  return (await response.json()) as TwitchTokenResponse;
};

export const validateTwitchToken = async (
  accessToken: string,
  fetchImpl = fetch,
) => {
  const response = await fetchImpl(`${twitchIdBase}/validate`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Twitch token validation failed: ${response.status}`);
  }
  return (await response.json()) as TwitchTokenValidation;
};

export const encryptedGrantFromToken = async (input: {
  installationId: string;
  kind: OAuthGrantKind;
  token: TwitchTokenResponse;
  validation: TwitchTokenValidation;
  encryptionKey: string;
}) => ({
  installation_id: input.installationId,
  grant_kind: input.kind,
  user_id: input.validation.user_id,
  login: input.validation.login,
  scopes_json: JSON.stringify(input.validation.scopes),
  encrypted_access_token: await encryptText(
    input.token.access_token,
    input.encryptionKey,
  ),
  encrypted_refresh_token: input.token.refresh_token
    ? await encryptText(input.token.refresh_token, input.encryptionKey)
    : null,
  token_expires_at: new Date(
    Date.now() + Math.max(0, input.token.expires_in) * 1000,
  ).toISOString(),
  updated_at: new Date().toISOString(),
});

export const accessTokenFromGrant = (
  grant: OAuthGrantRow,
  encryptionKey: string,
) => decryptText(grant.encrypted_access_token, encryptionKey);

export const verifyEventSubSignature = async (input: {
  messageId: string;
  timestamp: string;
  body: string;
  secret: string;
  signature: string;
}) => {
  const expected = `sha256=${await hmacSha256Hex(
    input.secret,
    `${input.messageId}${input.timestamp}${input.body}`,
  )}`;
  return constantTimeEqual(expected, input.signature);
};

export const normalizeChatEvent = (
  envelope: TwitchEventSubEnvelope,
): RelayChatEvent | null => {
  if (envelope.payload?.subscription?.type !== "channel.chat.message") {
    return null;
  }
  const event = envelope.payload.event;
  const text = event?.message?.text;
  const messageId = event?.message_id;
  const userId = event?.chatter_user_id;
  const userLogin = event?.chatter_user_login;
  const userDisplayName = event?.chatter_user_name;
  const broadcasterUserId = event?.broadcaster_user_id;
  if (
    !event ||
    !text ||
    !messageId ||
    !userId ||
    !userLogin ||
    !userDisplayName ||
    !broadcasterUserId
  ) {
    return null;
  }
  const badges = (event.badges ?? [])
    .map((badge) => badge.set_id)
    .filter((badge): badge is string => Boolean(badge));
  const isBroadcaster =
    userId === broadcasterUserId || badges.includes("broadcaster");
  return {
    id: messageId,
    text: text.slice(0, 500),
    userId,
    userLogin: userLogin.toLowerCase(),
    userDisplayName: userDisplayName.slice(0, 80),
    broadcasterUserId,
    badges,
    isBroadcaster,
    isMod: badges.includes("moderator"),
    isVip: badges.includes("vip"),
    isSubscriber: badges.includes("subscriber"),
    source: "relay-eventsub",
    receivedAt: new Date().toISOString(),
  };
};

export const sendAppTokenChatMessage = async (input: {
  clientId: string;
  appAccessToken: string;
  broadcasterId: string;
  senderId: string;
  message: string;
  fetchImpl?: typeof fetch;
}) => {
  const response = await (input.fetchImpl ?? fetch)(
    `${twitchApiBase}/chat/messages`,
    {
      method: "POST",
      headers: twitchHeaders(input.clientId, input.appAccessToken),
      body: JSON.stringify({
        broadcaster_id: input.broadcasterId,
        sender_id: input.senderId,
        message: input.message,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  return { response, body };
};

export const createChatMessageSubscription = async (input: {
  clientId: string;
  appAccessToken: string;
  broadcasterId: string;
  userId: string;
  callbackUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}) => {
  const response = await (input.fetchImpl ?? fetch)(
    `${twitchApiBase}/eventsub/subscriptions`,
    {
      method: "POST",
      headers: twitchHeaders(input.clientId, input.appAccessToken),
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: input.broadcasterId,
          user_id: input.userId,
        },
        transport: {
          method: "webhook",
          callback: input.callbackUrl,
          secret: input.secret,
        },
      }),
    },
  );
  const body = await response.json().catch(() => null);
  return { response, body };
};

const twitchHeaders = (clientId: string, accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "Client-Id": clientId,
  "Content-Type": "application/json",
});
