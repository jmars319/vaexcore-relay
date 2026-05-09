const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const randomToken = (bytes = 32) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
};

export const sha256Base64Url = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
};

export const constantTimeEqual = (left: string, right: string) => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
};

export const encryptText = async (plainText: string, base64Key: string) => {
  const key = await importAesKey(base64Key);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plainText),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
};

export const decryptText = async (cipherText: string, base64Key: string) => {
  const [ivText, cipherBody] = cipherText.split(".");
  if (!ivText || !cipherBody) {
    throw new Error("Encrypted token payload is malformed.");
  }

  const key = await importAesKey(base64Key);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(ivText) },
    key,
    base64UrlDecode(cipherBody),
  );
  return textDecoder.decode(plain);
};

export const hmacSha256Hex = async (secret: string, message: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const bytesToHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (value: string) => {
  const trimmed = value.trim();
  if (!/^(?:[a-f0-9]{2})+$/i.test(trimmed)) {
    throw new Error("Hex value is malformed.");
  }
  return Uint8Array.from(trimmed.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
};

const importAesKey = async (base64Key: string) => {
  const raw = base64Decode(base64Key);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes.");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
};

export const base64UrlEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const base64UrlDecode = (value: string) =>
  base64Decode(value.replaceAll("-", "+").replaceAll("_", "/"));

export const isValidEncryptionKey = (base64Key: string | undefined) => {
  if (!base64Key) return false;
  try {
    return base64Decode(base64Key).byteLength === 32;
  } catch {
    return false;
  }
};

const base64Decode = (value: string) => {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
