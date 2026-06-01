import { SafeInputError } from "../console-shared/core/security";
import type { RelayEnv } from "../env";
import { HttpError, json, readJson } from "../http";
import { registerEventSub, handleEventSubWebhook } from "./eventSub";
import { getQueuedEvents, sendChat } from "./chat";
import {
  applyHostedDiscordSetup,
  discordStatus,
  finishDiscordInstall,
  previewHostedDiscordSetup,
  registerDiscordCommands,
  startDiscordInstall,
  updateDiscordConfig,
} from "./discordInstall";
import {
  getDiscordSuggestions,
  getQueuedDiscordEvents,
  handleDiscordInteractionWebhook,
  updateDiscordSuggestionStatus,
} from "./discordInteractions";
import { pairConsole, startConsoleInstall } from "./console";
import { finishOAuth, startOAuth } from "./twitchOAuth";
import { consoleStatus, diagnostics, health, readinessReport } from "./status";
import { requireAdmin, requireConsole } from "../repositories";

type RouteHandler = (input: {
  request: Request;
  env: RelayEnv;
  ctx: ExecutionContext;
  url: URL;
}) => Promise<Response> | Response;

type Route = {
  method: string;
  path: string;
  handler: RouteHandler;
};

export const relayRoutes: Route[] = [
  { method: "GET", path: "/health", handler: () => health() },
  {
    method: "GET",
    path: "/diagnostics",
    handler: ({ request, env }) => diagnostics(request, env),
  },
  {
    method: "GET",
    path: "/admin/diagnostics",
    handler: ({ request, env }) => diagnostics(request, env),
  },
  {
    method: "POST",
    path: "/api/console/pair",
    handler: async ({ request, env }) => {
      await requireAdmin(request, env);
      return pairConsole(await readJson(request), env);
    },
  },
  {
    method: "POST",
    path: "/api/console/install/start",
    handler: async ({ request, env }) =>
      startConsoleInstall(await readJson(request), env),
  },
  {
    method: "GET",
    path: "/api/console/status",
    handler: ({ request, env, url }) => consoleStatus(request, env, url),
  },
  {
    method: "GET",
    path: "/api/console/readiness-report",
    handler: ({ request, env, url }) => readinessReport(request, env, url),
  },
  {
    method: "GET",
    path: "/api/console/discord/status",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return discordStatus(env, installation.id);
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/install/start",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return startDiscordInstall(await readJson(request), env, installation.id);
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/config",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return updateDiscordConfig(await readJson(request), env, installation.id);
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/setup/preview",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return previewHostedDiscordSetup(
        await readJson(request),
        env,
        installation.id,
      );
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/setup/apply",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return applyHostedDiscordSetup(
        await readJson(request),
        env,
        installation.id,
      );
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/commands/register",
    handler: async ({ request, env, url, ctx }) => {
      const installation = await requireConsole(request, env, url);
      return registerDiscordCommands(env, installation.id, ctx);
    },
  },
  {
    method: "GET",
    path: "/api/console/discord/events",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return getQueuedDiscordEvents(
        env,
        installation.id,
        Number(url.searchParams.get("limit") ?? "25"),
      );
    },
  },
  {
    method: "GET",
    path: "/api/console/discord/suggestions",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return getDiscordSuggestions(
        env,
        installation.id,
        url.searchParams.get("status"),
        Number(url.searchParams.get("limit") ?? "50"),
      );
    },
  },
  {
    method: "POST",
    path: "/api/console/discord/suggestions/status",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return updateDiscordSuggestionStatus(
        await readJson(request),
        env,
        installation.id,
      );
    },
  },
  {
    method: "GET",
    path: "/api/console/events",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return getQueuedEvents(
        env,
        installation.id,
        Number(url.searchParams.get("limit") ?? "25"),
      );
    },
  },
  {
    method: "POST",
    path: "/api/console/eventsub/register",
    handler: async ({ request, env, url, ctx }) => {
      const installation = await requireConsole(request, env, url);
      return registerEventSub(env, installation.id, ctx);
    },
  },
  {
    method: "POST",
    path: "/api/console/chat/send",
    handler: async ({ request, env, url }) => {
      const installation = await requireConsole(request, env, url);
      return sendChat(await readJson(request), env, installation.id);
    },
  },
  {
    method: "GET",
    path: "/oauth/twitch/start",
    handler: ({ url, env }) => startOAuth(url, env),
  },
  {
    method: "GET",
    path: "/oauth/twitch/callback",
    handler: ({ url, env, ctx }) => finishOAuth(url, env, ctx),
  },
  {
    method: "GET",
    path: "/oauth/discord/callback",
    handler: ({ url, env, ctx }) => finishDiscordInstall(url, env, ctx),
  },
  {
    method: "POST",
    path: "/webhooks/twitch/eventsub",
    handler: ({ request, env, ctx }) =>
      handleEventSubWebhook(request, env, ctx),
  },
  {
    method: "POST",
    path: "/webhooks/discord/interactions",
    handler: ({ request, env, url, ctx }) =>
      handleDiscordInteractionWebhook(request, env, url, ctx),
  },
];

export const assertUniqueRoutes = (routes: Route[] = relayRoutes) => {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`Duplicate Relay route: ${key}`);
    seen.add(key);
  }
};

assertUniqueRoutes();

export const handleRequest = async (
  request: Request,
  env: RelayEnv,
  ctx: ExecutionContext,
) => {
  const url = new URL(request.url);
  try {
    const route = relayRoutes.find(
      (item) => item.method === request.method && item.path === url.pathname,
    );
    if (!route) return json({ ok: false, error: "Not found" }, { status: 404 });
    return await route.handler({ request, env, ctx, url });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Relay request failed",
      },
      {
        status:
          error instanceof HttpError
            ? error.status
            : error instanceof SafeInputError
              ? 400
              : 500,
      },
    );
  }
};
