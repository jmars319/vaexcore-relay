import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256Hex } from "../src/crypto";
import {
  buildTwitchAuthorizeUrl,
  missingScopes,
  normalizeChatEvent,
  verifyEventSubSignature,
} from "../src/twitch";
import { requiredBotScopes } from "../src/types";

test("buildTwitchAuthorizeUrl requests grant-specific bot scopes", () => {
  const url = new URL(
    buildTwitchAuthorizeUrl({
      clientId: "client",
      redirectUri: "https://relay.example/oauth/twitch/callback",
      state: "state",
      kind: "bot",
    }),
  );
  assert.equal(url.hostname, "id.twitch.tv");
  assert.equal(url.searchParams.get("client_id"), "client");
  assert.deepEqual(url.searchParams.get("scope")?.split(" "), [
    ...requiredBotScopes,
  ]);
});

test("missingScopes reports exact missing authorization", () => {
  assert.deepEqual(missingScopes(["user:bot"], requiredBotScopes), [
    "user:read:chat",
    "user:write:chat",
  ]);
});

test("verifyEventSubSignature validates Twitch webhook headers", async () => {
  const body = JSON.stringify({ payload: { challenge: "ok" } });
  const messageId = "message-id";
  const timestamp = "2026-05-09T00:00:00Z";
  const signature = `sha256=${await hmacSha256Hex("secret", `${messageId}${timestamp}${body}`)}`;
  assert.equal(
    await verifyEventSubSignature({
      messageId,
      timestamp,
      body,
      secret: "secret",
      signature,
    }),
    true,
  );
});

test("normalizeChatEvent maps EventSub chat messages to Console-friendly shape", () => {
  const normalized = normalizeChatEvent({
    metadata: { message_type: "notification" },
    payload: {
      subscription: { type: "channel.chat.message" },
      event: {
        broadcaster_user_id: "broadcaster",
        chatter_user_id: "viewer",
        chatter_user_login: "ViewerLogin",
        chatter_user_name: "Viewer",
        message_id: "msg-1",
        message: { text: "!ping" },
        badges: [{ set_id: "vip" }],
      },
    },
  });
  assert.equal(normalized?.id, "msg-1");
  assert.equal(normalized?.source, "relay-eventsub");
  assert.equal(normalized?.isVip, true);
});

test("normalizeChatEvent maps Twitch webhook chat message bodies", () => {
  const normalized = normalizeChatEvent({
    subscription: { type: "channel.chat.message" },
    event: {
      broadcaster_user_id: "broadcaster",
      chatter_user_id: "viewer",
      chatter_user_login: "ViewerLogin",
      chatter_user_name: "Viewer",
      message_id: "msg-2",
      message: { text: "relay inbound test" },
      badges: [{ set_id: "moderator" }],
    },
  });
  assert.equal(normalized?.id, "msg-2");
  assert.equal(normalized?.text, "relay inbound test");
  assert.equal(normalized?.isMod, true);
});
