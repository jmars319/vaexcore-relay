import { getAdminDiagnostics } from "../diagnostics";
import { serviceName, serviceVersion, type RelayEnv } from "../env";
import { json } from "../http";
import {
  getFreshness,
  getLatestReadinessRecords,
  getQueueHealth,
  getReadiness,
  getSchemaReadiness,
  latestRecordMetadata,
} from "../readiness";
import { getBotReadinessReport } from "../readinessReport";
import {
  requireAdmin,
  requireConsole,
  safeInstallation,
} from "../repositories";

export const health = () =>
  json({
    ok: true,
    service: serviceName,
    version: serviceVersion,
    capabilities: [
      "twitch.chatbot-identity",
      "twitch.eventsub.webhooks",
      "twitch.app-token-chat",
      "discord.interactions-webhook",
      "discord.suggestion-queue",
      "discord.command-registration",
    ],
  });

export const diagnostics = async (request: Request, env: RelayEnv) => {
  await requireAdmin(request, env);
  return json(await getAdminDiagnostics(env));
};

export const consoleStatus = async (
  request: Request,
  env: RelayEnv,
  url: URL,
) => {
  const installation = await requireConsole(request, env, url);
  const [readiness, schema, queues, freshness, latest] = await Promise.all([
    getReadiness(env, installation.id),
    getSchemaReadiness(env),
    getQueueHealth(env, installation.id),
    getFreshness(env, installation.id),
    getLatestReadinessRecords(env, installation.id),
  ]);
  return json({
    ok: true,
    installation: safeInstallation(installation),
    readiness,
    schema,
    queues,
    freshness,
    latestRecordMetadata: latestRecordMetadata(latest),
  });
};

export const readinessReport = async (
  request: Request,
  env: RelayEnv,
  url: URL,
) => {
  const installation = await requireConsole(request, env, url);
  return json(await getBotReadinessReport(env, installation));
};
