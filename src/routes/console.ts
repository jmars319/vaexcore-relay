import { randomToken, sha256Base64Url } from "../crypto";
import type { RelayEnv } from "../env";
import { json, objectInput, optionalBoundedString } from "../http";
import { writeAudit } from "../repositories";

export const pairConsole = async (body: unknown, env: RelayEnv) => {
  const input = objectInput(body);
  const name =
    optionalBoundedString(input.name, "Installation name", 80) ||
    "VaexCore Console";
  return createConsoleInstallation(env, name);
};

export const startConsoleInstall = async (body: unknown, env: RelayEnv) => {
  const input = objectInput(body);
  const name =
    optionalBoundedString(input.name, "Installation name", 80) ||
    "VaexCore Console";
  return createConsoleInstallation(env, name);
};

const createConsoleInstallation = async (env: RelayEnv, name: string) => {
  const id = crypto.randomUUID();
  const consoleToken = randomToken(32);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO installations (
        id, name, console_token_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(id, name, await sha256Base64Url(consoleToken), now, now)
    .run();
  await writeAudit(env, id, "installation.create", id, { name });
  return json({
    ok: true,
    installationId: id,
    consoleToken,
    next: {
      twitchCallbackUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/callback`,
      botOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=bot`,
      broadcasterOAuthUrl: `${env.PUBLIC_BASE_URL}/oauth/twitch/start?installationId=${id}&kind=broadcaster`,
      twitchEventSubWebhookUrl: `${env.PUBLIC_BASE_URL}/webhooks/twitch/eventsub`,
      discordInteractionUrl: `${env.PUBLIC_BASE_URL}/webhooks/discord/interactions`,
    },
  });
};
