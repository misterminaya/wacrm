-- ============================================================
-- SMS MESSAGES (Twilio inbound)
--
-- Flat store for SMS received via POST /api/twilio/webhook.
-- Receive-only in this version: rows are inserted exclusively by
-- the webhook (service-role client, which bypasses RLS), so there
-- is deliberately NO INSERT policy — authenticated users cannot
-- write rows directly.
--
-- Idempotent — safe to run multiple times, like every migration
-- in this directory.
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Set when the sender's number matches an existing contact of the
  -- account (same last-8-digit logic the WhatsApp webhook uses).
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  from_number  TEXT NOT NULL,
  to_number    TEXT NOT NULL,
  body         TEXT,
  -- Twilio MessageSid. Unique so webhook retries (Twilio retries on
  -- non-2xx) can never insert the same SMS twice.
  twilio_sid   TEXT NOT NULL UNIQUE,
  num_media    INTEGER NOT NULL DEFAULT 0,
  -- MediaUrl0..N from MMS payloads, as a JSON array of strings.
  media_urls   JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_account_received
  ON sms_messages(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_from_number
  ON sms_messages(from_number);

ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;

-- Members of the account can read its SMS.
DROP POLICY IF EXISTS sms_messages_select ON sms_messages;
CREATE POLICY sms_messages_select ON sms_messages
  FOR SELECT USING (is_account_member(account_id));

-- Agents+ can delete (clean up spam). No INSERT/UPDATE policies:
-- inserts come only from the service-role webhook client (bypasses
-- RLS) and rows are immutable once stored.
DROP POLICY IF EXISTS sms_messages_delete ON sms_messages;
CREATE POLICY sms_messages_delete ON sms_messages
  FOR DELETE USING (is_account_member(account_id, 'agent'));
