import { randomToken } from "../crypto";
import type { RelayEnv } from "../env";
import { grantKind, html, HttpError, stringInput } from "../http";
import {
  getInstallation,
  requireRelayReadyGrants,
  writeAudit,
} from "../repositories";
import {
  buildTwitchAuthorizeUrl,
  encryptedGrantFromToken,
  exchangeTwitchCode,
  missingScopes,
  scopesForGrant,
  validateTwitchToken,
} from "../twitch";
import type { OAuthGrantKind } from "../types";
import { registerEventSub } from "./eventSub";

export const startOAuth = async (url: URL, env: RelayEnv) => {
  const installationId = stringInput(
    url.searchParams.get("installationId"),
    "Installation ID",
    80,
  );
  const kind = grantKind(url.searchParams.get("kind"));
  const installation = await getInstallation(env, installationId);
  if (!installation) throw new HttpError(404, "Installation was not found.");
  const state = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `
      INSERT INTO oauth_states (
        state, installation_id, grant_kind, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  )
    .bind(state, installationId, kind, now.toISOString(), expiresAt)
    .run();
  return Response.redirect(
    buildTwitchAuthorizeUrl({
      clientId: env.TWITCH_CLIENT_ID,
      redirectUri: env.TWITCH_REDIRECT_URI,
      state,
      kind,
    }),
    302,
  );
};

export const finishOAuth = async (
  url: URL,
  env: RelayEnv,
  ctx: ExecutionContext,
) => {
  const code = stringInput(url.searchParams.get("code"), "OAuth code", 400);
  const state = stringInput(url.searchParams.get("state"), "OAuth state", 120);
  const stateRow = await env.DB.prepare(
    `
      SELECT state, installation_id, grant_kind, expires_at
      FROM oauth_states
      WHERE state = ?
    `,
  )
    .bind(state)
    .first<{
      installation_id: string;
      grant_kind: OAuthGrantKind;
      expires_at: string;
    }>();
  if (!stateRow || Date.parse(stateRow.expires_at) < Date.now()) {
    throw new HttpError(400, "OAuth state is missing or expired.");
  }
  const token = await exchangeTwitchCode({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    redirectUri: env.TWITCH_REDIRECT_URI,
    code,
  });
  const validation = await validateTwitchToken(token.access_token);
  const required = scopesForGrant(stateRow.grant_kind);
  const missing = missingScopes(validation.scopes, required);
  if (missing.length > 0) {
    throw new HttpError(
      403,
      `Twitch grant is missing required scope(s): ${missing.join(", ")}`,
    );
  }
  const grant = await encryptedGrantFromToken({
    installationId: stateRow.installation_id,
    kind: stateRow.grant_kind,
    token,
    validation,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  });
  await env.DB.prepare(
    `
      INSERT INTO oauth_grants (
        installation_id, grant_kind, user_id, login, scopes_json,
        encrypted_access_token, encrypted_refresh_token, token_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, grant_kind) DO UPDATE SET
        user_id = excluded.user_id,
        login = excluded.login,
        scopes_json = excluded.scopes_json,
        encrypted_access_token = excluded.encrypted_access_token,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        token_expires_at = excluded.token_expires_at,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      grant.installation_id,
      grant.grant_kind,
      grant.user_id,
      grant.login,
      grant.scopes_json,
      grant.encrypted_access_token,
      grant.encrypted_refresh_token,
      grant.token_expires_at,
      grant.updated_at,
    )
    .run();
  const columnPrefix = stateRow.grant_kind === "bot" ? "bot" : "broadcaster";
  await env.DB.prepare(
    `
      UPDATE installations
      SET ${columnPrefix}_user_id = ?, ${columnPrefix}_login = ?, updated_at = ?
      WHERE id = ?
    `,
  )
    .bind(
      validation.user_id,
      validation.login,
      new Date().toISOString(),
      stateRow.installation_id,
    )
    .run();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?")
    .bind(state)
    .run();
  await writeAudit(
    env,
    stateRow.installation_id,
    `oauth.${stateRow.grant_kind}.connected`,
    validation.user_id,
    { login: validation.login, scopes: validation.scopes },
  );
  const eventSub = await maybeRegisterEventSubAfterOAuth(
    env,
    stateRow.installation_id,
    ctx,
  );
  const eventSubMessage =
    eventSub.status === "registered"
      ? " EventSub was registered automatically."
      : eventSub.status === "already-registered"
        ? " EventSub was already registered."
        : eventSub.status === "pending"
          ? " Finish the other Twitch authorization in Console to enable automatic EventSub registration."
          : ` EventSub still needs attention: ${eventSub.message}`;
  return html(
    `Twitch authorization saved.${eventSubMessage} You can close this tab and return to vaexcore console.`,
  );
};

const maybeRegisterEventSubAfterOAuth = async (
  env: RelayEnv,
  installationId: string,
  ctx: ExecutionContext,
): Promise<
  | { status: "registered" }
  | { status: "already-registered" }
  | { status: "pending" }
  | { status: "failed"; message: string }
> => {
  if (await hasCreatedEventSubRegistration(env, installationId)) {
    return { status: "already-registered" };
  }
  try {
    await requireRelayReadyGrants(env, installationId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      if (error.message.includes("separate")) {
        return { status: "failed", message: error.message };
      }
      return { status: "pending" };
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
  try {
    await registerEventSub(env, installationId, ctx);
    return { status: "registered" };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
};

const hasCreatedEventSubRegistration = async (
  env: RelayEnv,
  installationId: string,
) => {
  const existing = await env.DB.prepare(
    `
      SELECT id
      FROM eventsub_subscriptions
      WHERE installation_id = ?
        AND type = 'channel.chat.message'
        AND status = 'created'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  )
    .bind(installationId)
    .first<{ id: string }>();
  return Boolean(existing);
};
