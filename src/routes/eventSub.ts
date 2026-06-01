import type { RelayEnv } from "../env";
import {
  getFirstDataItem,
  headerValue,
  HttpError,
  json,
  readBoundedText,
  stringFrom,
} from "../http";
import {
  findInstallationForBroadcaster,
  requireRelayReadyGrants,
  writeAudit,
} from "../repositories";
import {
  createChatMessageSubscription,
  getAppAccessToken,
  normalizeChatEvent,
  verifyEventSubSignature,
} from "../twitch";
import type { TwitchEventSubEnvelope } from "../types";
import { maxJsonBytes } from "../env";

export const registerEventSub = async (
  env: RelayEnv,
  installationId: string,
  ctx: ExecutionContext,
) => {
  const { installation, botGrant, broadcasterGrant } =
    await requireRelayReadyGrants(env, installationId);
  const appToken = await getAppAccessToken({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
  });
  const result = await createChatMessageSubscription({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken: appToken.access_token,
    broadcasterId: broadcasterGrant.user_id,
    userId: botGrant.user_id,
    callbackUrl: `${env.PUBLIC_BASE_URL}/webhooks/twitch/eventsub`,
    secret: env.TWITCH_EVENTSUB_SECRET,
  });
  const subscription = getFirstDataItem(result.body);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO eventsub_subscriptions (
        id, installation_id, twitch_subscription_id, type, version, status,
        condition_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installation.id,
      stringFrom(subscription?.id),
      "channel.chat.message",
      "1",
      result.response.ok ? "created" : "failed",
      JSON.stringify({
        broadcaster_user_id: broadcasterGrant.user_id,
        user_id: botGrant.user_id,
      }),
      now,
      now,
    )
    .run();
  ctx.waitUntil(
    writeAudit(
      env,
      installationId,
      "eventsub.chat.register",
      stringFrom(subscription?.id),
      { ok: result.response.ok, status: result.response.status },
    ),
  );
  if (!result.response.ok) {
    throw new HttpError(
      result.response.status,
      "Twitch rejected EventSub registration.",
    );
  }
  return json({ ok: true, subscription });
};

export const handleEventSubWebhook = async (
  request: Request,
  env: RelayEnv,
  ctx: ExecutionContext,
) => {
  const body = await readBoundedText(request, maxJsonBytes);
  const messageId = headerValue(request, "Twitch-Eventsub-Message-Id");
  const timestamp = headerValue(request, "Twitch-Eventsub-Message-Timestamp");
  const signature = headerValue(request, "Twitch-Eventsub-Message-Signature");
  const verified = await verifyEventSubSignature({
    messageId,
    timestamp,
    body,
    secret: env.TWITCH_EVENTSUB_SECRET,
    signature,
  });
  if (!verified) {
    throw new HttpError(403, "EventSub signature verification failed.");
  }
  const envelope = JSON.parse(body) as TwitchEventSubEnvelope;
  const messageType =
    request.headers.get("Twitch-Eventsub-Message-Type") ??
    envelope.metadata?.message_type;
  if (messageType === "webhook_callback_verification") {
    return new Response(
      envelope.challenge ?? envelope.payload?.challenge ?? "",
      {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }
  const event = normalizeChatEvent(envelope);
  if (event) {
    const installation = await findInstallationForBroadcaster(
      env,
      event.broadcasterUserId,
    );
    if (installation) {
      await env.DB.prepare(
        `
          INSERT OR IGNORE INTO chat_events (
            id, installation_id, twitch_message_id, event_json, received_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
        .bind(
          crypto.randomUUID(),
          installation.id,
          event.id,
          JSON.stringify(event),
          event.receivedAt,
        )
        .run();
      ctx.waitUntil(
        writeAudit(env, installation.id, "eventsub.chat.message", event.id, {
          userLogin: event.userLogin,
        }),
      );
    }
  }
  return json({ ok: true });
};
