import type { RelayEnv } from "./env";
import type { OAuthGrantKind, DiscordSuggestionStatus } from "./types";
import { maxJsonBytes } from "./env";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const readBoundedText = async (request: Request, maxBytes: number) => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  return text;
};

export const readJson = async (request: Request) =>
  JSON.parse(await readBoundedText(request, maxJsonBytes));

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });

export const html = (body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>VaexCore Relay</title><p>${escapeHtml(body)}</p>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );

export const objectInput = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
};

export const stringInput = (
  value: unknown,
  field: string,
  maxLength: number,
) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} is too long.`);
  }
  return trimmed;
};

export const discordSnowflakeInput = (value: unknown, field: string) => {
  const snowflake = stringInput(value, field, 32);
  if (!/^\d{5,32}$/.test(snowflake)) {
    throw new HttpError(400, `${field} must be a Discord ID.`);
  }
  return snowflake;
};

export const optionalBoundedString = (
  value: unknown,
  field: string,
  maxLength: number,
) => {
  if (value === undefined || value === null || value === "") return null;
  return stringInput(value, field, maxLength);
};

export const grantKind = (value: unknown): OAuthGrantKind => {
  if (value === "bot" || value === "broadcaster") return value;
  throw new HttpError(400, "OAuth grant kind must be bot or broadcaster.");
};

export const bearerToken = (request: Request) => {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
};

export const headerValue = (request: Request, name: string) => {
  const value = request.headers.get(name);
  if (!value) {
    throw new HttpError(400, `${name} header is required.`);
  }
  return value;
};

export const getFirstDataItem = (
  body: unknown,
): Record<string, unknown> | null => {
  if (
    body &&
    typeof body === "object" &&
    "data" in body &&
    Array.isArray(body.data)
  ) {
    return (body.data[0] as Record<string, unknown> | undefined) ?? null;
  }
  return null;
};

export const stringFrom = (value: unknown) =>
  typeof value === "string" ? value : null;

export const jsonRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, item]) => typeof item === "string")
        .map(([key, item]) => [key, item as string]),
    );
  } catch {
    return {};
  }
};

export const requiredEnv = (value: string | undefined, name: string) => {
  if (!value?.trim()) {
    throw new HttpError(409, `${name} is not configured.`);
  }
  return value.trim();
};

export const suggestionStatus = (value: unknown): DiscordSuggestionStatus => {
  if (
    value === "new" ||
    value === "reviewed" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "archived"
  ) {
    return value;
  }
  throw new HttpError(
    400,
    "Suggestion status must be new, reviewed, accepted, rejected, or archived.",
  );
};

export const discordInteractionUrl = (env: RelayEnv) =>
  `${env.PUBLIC_BASE_URL}/webhooks/discord/interactions`;

export const discordRedirectUri = (env: RelayEnv) =>
  `${env.PUBLIC_BASE_URL}/oauth/discord/callback`;

export const retryAfterMs = (response: Response) => {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

export const redact = (value: unknown): unknown => {
  if (typeof value === "string") {
    return /token|secret|authorization|oauth/i.test(value)
      ? "[redacted]"
      : value.slice(0, 500);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|authorization|oauth/i.test(key)
          ? "[redacted]"
          : redact(item),
      ]),
    );
  }
  return value;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
