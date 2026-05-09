import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/crypto";
import {
  discordApplicationCommands,
  discordOptionRecord,
  hasDiscordOperatorPermission,
  registerDiscordApplicationCommands,
  verifyDiscordInteractionSignature,
} from "../src/discord";

const textEncoder = new TextEncoder();

test("verifyDiscordInteractionSignature validates Ed25519 Discord requests", async () => {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const timestamp = "2026-05-09T00:00:00Z";
  const body = JSON.stringify({ type: 1 });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keyPair.privateKey,
    textEncoder.encode(`${timestamp}${body}`),
  );
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);

  assert.equal(
    await verifyDiscordInteractionSignature({
      publicKey: bytesToHex(new Uint8Array(publicKey)),
      signature: bytesToHex(new Uint8Array(signature)),
      timestamp,
      body,
    }),
    true,
  );
  assert.equal(
    await verifyDiscordInteractionSignature({
      publicKey: bytesToHex(new Uint8Array(publicKey)),
      signature: bytesToHex(new Uint8Array(signature)),
      timestamp,
      body: JSON.stringify({ type: 2 }),
    }),
    false,
  );
});

test("discordApplicationCommands defines the supported streamer slash commands", () => {
  assert.deepEqual(
    discordApplicationCommands().map((command) => command.name),
    ["suggest", "live", "late", "cancelled", "scheduled", "setup-status"],
  );
});

test("registerDiscordApplicationCommands bulk overwrites guild commands", async () => {
  let requestUrl = "";
  let requestBody: unknown = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? "null"));
    return Response.json([{ name: "suggest" }]);
  };

  const result = await registerDiscordApplicationCommands({
    applicationId: "app",
    botToken: "bot-token",
    guildId: "guild",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.response.ok, true);
  assert.equal(result.scope, "guild");
  assert.equal(
    requestUrl,
    "https://discord.com/api/v10/applications/app/guilds/guild/commands",
  );
  assert.ok(Array.isArray(requestBody));
});

test("discord option and operator helpers keep public commands guarded", () => {
  const interaction = {
    data: {
      options: [
        { name: "text", type: 3, value: "Clip the boss fight" },
        { name: "count", type: 4, value: 3 },
      ],
    },
    member: {
      roles: ["operator-role"],
      permissions: "0",
    },
  };

  assert.deepEqual(discordOptionRecord(interaction), {
    text: "Clip the boss fight",
    count: 3,
  });
  assert.equal(
    hasDiscordOperatorPermission(interaction, "operator-role"),
    true,
  );
  assert.equal(
    hasDiscordOperatorPermission({ member: { permissions: "32" } }),
    true,
  );
  assert.equal(
    hasDiscordOperatorPermission({ member: { permissions: "0" } }),
    false,
  );
});
