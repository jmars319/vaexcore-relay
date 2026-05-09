import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeEqual,
  decryptText,
  encryptText,
  hmacSha256Hex,
  isValidEncryptionKey,
  randomToken,
  sha256Base64Url,
} from "../src/crypto";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

test("encryptText and decryptText round trip secrets", async () => {
  const encrypted = await encryptText("secret-token", key);
  assert.notEqual(encrypted, "secret-token");
  assert.equal(await decryptText(encrypted, key), "secret-token");
});

test("hash and random helpers produce stable safe values", async () => {
  assert.equal(await sha256Base64Url("abc"), await sha256Base64Url("abc"));
  assert.notEqual(randomToken(), randomToken());
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "different"), false);
  assert.equal(isValidEncryptionKey(key), true);
  assert.equal(isValidEncryptionKey(btoa("short")), false);
  assert.equal(isValidEncryptionKey("not base64!"), false);
});

test("hmacSha256Hex signs known message", async () => {
  const signature = await hmacSha256Hex("secret", "message");
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(signature, await hmacSha256Hex("secret", "message"));
});
