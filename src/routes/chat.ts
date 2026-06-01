import {
  defaultRetryBackoffMs,
  maxOutboundRetryAttempts,
  outboundRetryBatchLimit,
  type RelayEnv,
} from "../env";
import {
  getFirstDataItem,
  HttpError,
  json,
  objectInput,
  optionalBoundedString,
  retryAfterMs,
  stringFrom,
  stringInput,
} from "../http";
import {
  getOutboundSendByIdempotencyKey,
  requireRelayReadyGrants,
  writeAudit,
} from "../repositories";
import {
  accessTokenFromGrant,
  getAppAccessToken,
  sendAppTokenChatMessage,
} from "../twitch";
import type { OutboundChatSendRow } from "../types";

export const getQueuedEvents = async (
  env: RelayEnv,
  installationId: string,
  limit: number,
) => {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 100)
    : 25;
  const rows = await env.DB.prepare(
    `
      SELECT id, event_json
      FROM chat_events
      WHERE installation_id = ? AND delivered_at IS NULL
      ORDER BY received_at ASC
      LIMIT ?
    `,
  )
    .bind(installationId, safeLimit)
    .all<{ id: string; event_json: string }>();
  const events = rows.results.map((row) => ({
    relayEventId: row.id,
    ...JSON.parse(row.event_json),
  }));
  if (events.length > 0) {
    const now = new Date().toISOString();
    const statements = rows.results.map((row) =>
      env.DB.prepare(
        "UPDATE chat_events SET delivered_at = ? WHERE id = ?",
      ).bind(now, row.id),
    );
    await env.DB.batch(statements);
  }
  return json({ ok: true, events });
};

export const sendChat = async (
  body: unknown,
  env: RelayEnv,
  installationId: string,
) => {
  const input = objectInput(body);
  const message = stringInput(input.message, "Chat message", 500);
  const idempotencyKey = optionalBoundedString(
    input.idempotencyKey ?? input.idempotency_key,
    "Idempotency key",
    120,
  );
  if (idempotencyKey) {
    const existing = await getOutboundSendByIdempotencyKey(
      env,
      installationId,
      idempotencyKey,
    );
    if (existing) {
      return json({
        ok: existing.status === "sent",
        messageId: existing.twitch_message_id ?? "",
        transport: "relay-chatbot",
        idempotentReplay: true,
        status: existing.status,
        failureCategory: existing.failure_category ?? undefined,
        reason: existing.final_drop_reason ?? existing.reason ?? undefined,
        retryAfterMs: existing.retry_after_ms ?? undefined,
        nextRetryAt: existing.next_retry_at ?? undefined,
      });
    }
  }
  const { botGrant, broadcasterGrant } = await requireRelayReadyGrants(
    env,
    installationId,
  );
  await accessTokenFromGrant(botGrant, env.TOKEN_ENCRYPTION_KEY);
  const appToken = await getAppAccessToken({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
  });
  const result = await sendAppTokenChatMessage({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken: appToken.access_token,
    broadcasterId: broadcasterGrant.user_id,
    senderId: botGrant.user_id,
    message,
  });
  const data = getFirstDataItem(result.body);
  const dropReason = data?.drop_reason ? JSON.stringify(data.drop_reason) : "";
  const sent = result.response.ok && data?.is_sent !== false;
  const now = new Date().toISOString();
  const persistence = outboundSendPersistence({
    sent,
    retryAfterMs: retryAfterMs(result.response),
    fallbackReason: dropReason || `Twitch response ${result.response.status}`,
    now,
  });
  await env.DB.prepare(
    `
      INSERT INTO outbound_chat_sends (
        id, installation_id, broadcaster_user_id, sender_user_id, message,
        status, twitch_message_id, failure_category, reason, retry_after_ms,
        idempotency_key, retry_count, next_retry_at, dead_lettered_at,
        final_drop_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      crypto.randomUUID(),
      installationId,
      broadcasterGrant.user_id,
      botGrant.user_id,
      message,
      persistence.status,
      stringFrom(data?.message_id),
      sent ? null : "twitch_rejected",
      sent ? null : persistence.reason,
      persistence.retryAfterMs,
      idempotencyKey,
      persistence.retryCount,
      persistence.nextRetryAt,
      persistence.deadLetteredAt,
      persistence.finalDropReason,
      now,
      now,
    )
    .run();
  await writeAudit(
    env,
    installationId,
    "chat.send",
    stringFrom(data?.message_id),
    {
      ok: sent,
      status: result.response.status,
    },
  );
  if (!sent) {
    throw new HttpError(
      result.response.ok ? 502 : result.response.status,
      "Twitch did not send the chat message.",
    );
  }
  return json({
    ok: true,
    messageId: stringFrom(data?.message_id),
    transport: "relay-chatbot",
    idempotentReplay: false,
  });
};

export const processOutboundRetryQueue = async (
  env: RelayEnv,
  options: { now?: string; limit?: number } = {},
) => {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? outboundRetryBatchLimit)),
    100,
  );
  const rows = await env.DB.prepare(
    `
      SELECT *
      FROM outbound_chat_sends
      WHERE status = 'retry'
        AND dead_lettered_at IS NULL
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY COALESCE(next_retry_at, created_at) ASC
      LIMIT ?
    `,
  )
    .bind(now, limit)
    .all<OutboundChatSendRow>();
  const summary = {
    ok: true,
    processed: rows.results.length,
    sent: 0,
    retry: 0,
    failed: 0,
    errors: 0,
    maxAttempts: maxOutboundRetryAttempts,
  };
  if (rows.results.length === 0) return summary;
  let appAccessToken = "";
  try {
    const appToken = await getAppAccessToken({
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
    });
    appAccessToken = appToken.access_token;
  } catch (error) {
    await writeAudit(env, null, "chat.retry.worker", "app-token", {
      ok: false,
      error: error instanceof Error ? error.message : "App token unavailable.",
    });
    return { ...summary, ok: false, errors: rows.results.length };
  }
  for (const row of rows.results) {
    try {
      const result = await retryOutboundChatSend(env, row, appAccessToken, now);
      summary[result.status] += 1;
    } catch (error) {
      summary.errors += 1;
      await markRetryWorkerFailure(env, row, now, error);
    }
  }
  return summary;
};

const retryOutboundChatSend = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  appAccessToken: string,
  now: string,
) => {
  const result = await sendAppTokenChatMessage({
    clientId: env.TWITCH_CLIENT_ID,
    appAccessToken,
    broadcasterId: row.broadcaster_user_id,
    senderId: row.sender_user_id,
    message: row.message,
  });
  const data = getFirstDataItem(result.body);
  const dropReason = data?.drop_reason ? JSON.stringify(data.drop_reason) : "";
  const sent = result.response.ok && data?.is_sent !== false;
  const persistence = outboundRetryPersistence({
    sent,
    retryAfterMs: retryAfterMs(result.response),
    fallbackReason: dropReason || `Twitch response ${result.response.status}`,
    now,
    currentRetryCount: row.retry_count,
    maxRetryCount: maxOutboundRetryAttempts,
  });
  await persistRetryResult(env, row, persistence, stringFrom(data?.message_id));
  await writeAudit(
    env,
    row.installation_id,
    retryAuditAction(persistence.status),
    row.id,
    {
      ok: persistence.status === "sent",
      status: result.response.status,
      retryCount: persistence.retryCount,
      nextRetryAt: persistence.nextRetryAt,
      finalDropReason: persistence.finalDropReason,
    },
  );
  return persistence;
};

const markRetryWorkerFailure = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  now: string,
  error: unknown,
) => {
  const persistence = outboundRetryPersistence({
    sent: false,
    retryAfterMs: defaultRetryBackoffMs,
    fallbackReason:
      error instanceof Error ? error.message : "Retry worker send failed.",
    now,
    currentRetryCount: row.retry_count,
    maxRetryCount: maxOutboundRetryAttempts,
  });
  await persistRetryResult(env, row, persistence, null);
  await writeAudit(
    env,
    row.installation_id,
    retryAuditAction(persistence.status),
    row.id,
    {
      ok: false,
      retryCount: persistence.retryCount,
      nextRetryAt: persistence.nextRetryAt,
      finalDropReason: persistence.finalDropReason,
    },
  );
};

const persistRetryResult = async (
  env: RelayEnv,
  row: OutboundChatSendRow,
  persistence: ReturnType<typeof outboundRetryPersistence>,
  twitchMessageId: string | null,
) =>
  env.DB.prepare(
    `
      UPDATE outbound_chat_sends
      SET status = ?,
        twitch_message_id = ?,
        failure_category = ?,
        reason = ?,
        retry_after_ms = ?,
        retry_count = ?,
        next_retry_at = ?,
        dead_lettered_at = ?,
        final_drop_reason = ?,
        updated_at = ?
      WHERE id = ? AND status = 'retry'
    `,
  )
    .bind(
      persistence.status,
      twitchMessageId,
      persistence.status === "sent" ? null : "twitch_retry",
      persistence.reason,
      persistence.retryAfterMs,
      persistence.retryCount,
      persistence.nextRetryAt,
      persistence.deadLetteredAt,
      persistence.finalDropReason,
      persistence.updatedAt,
      row.id,
    )
    .run();

const retryAuditAction = (status: "sent" | "retry" | "failed") => {
  if (status === "sent") return "chat.retry.sent";
  if (status === "retry") return "chat.retry.scheduled";
  return "chat.retry.dead_letter";
};

export const outboundSendPersistence = (input: {
  sent: boolean;
  retryAfterMs: number | null;
  fallbackReason: string;
  now: string;
}) => {
  const nextRetryAt = input.retryAfterMs
    ? new Date(Date.parse(input.now) + input.retryAfterMs).toISOString()
    : null;
  const status = input.sent ? "sent" : input.retryAfterMs ? "retry" : "failed";
  const deadLetteredAt = !input.sent && !input.retryAfterMs ? input.now : null;
  return {
    status,
    reason: input.sent ? null : input.fallbackReason,
    retryAfterMs: input.retryAfterMs,
    retryCount: input.sent ? 0 : 1,
    nextRetryAt,
    deadLetteredAt,
    finalDropReason: deadLetteredAt ? input.fallbackReason : null,
  } as const;
};

export const outboundRetryPersistence = (input: {
  sent: boolean;
  retryAfterMs: number | null;
  fallbackReason: string;
  now: string;
  currentRetryCount: number;
  maxRetryCount: number;
}) => {
  const retryCount = input.currentRetryCount + 1;
  const canRetry =
    !input.sent &&
    input.retryAfterMs !== null &&
    retryCount < input.maxRetryCount;
  const status = input.sent ? "sent" : canRetry ? "retry" : "failed";
  const nextRetryAt = canRetry
    ? new Date(Date.parse(input.now) + input.retryAfterMs!).toISOString()
    : null;
  const deadLetteredAt = status === "failed" ? input.now : null;
  return {
    status,
    reason: input.sent ? null : input.fallbackReason,
    retryAfterMs: input.sent ? null : input.retryAfterMs,
    retryCount,
    nextRetryAt,
    deadLetteredAt,
    finalDropReason: deadLetteredAt ? input.fallbackReason : null,
    updatedAt: input.now,
  } as const;
};
