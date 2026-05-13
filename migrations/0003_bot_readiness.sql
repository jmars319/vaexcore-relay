ALTER TABLE outbound_chat_sends ADD COLUMN idempotency_key TEXT;
ALTER TABLE outbound_chat_sends ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_chat_sends ADD COLUMN next_retry_at TEXT;
ALTER TABLE outbound_chat_sends ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE outbound_chat_sends ADD COLUMN final_drop_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_chat_sends_idempotency
  ON outbound_chat_sends(installation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_chat_sends_retry
  ON outbound_chat_sends(installation_id, status, next_retry_at);
