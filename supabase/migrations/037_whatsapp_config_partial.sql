-- ============================================================
-- WHATSAPP_CONFIG: allow partial rows (verify token first)
--
-- Settings → WhatsApp can now save ONLY the webhook verify token
-- before the operator has Meta credentials, so Facebook's webhook
-- verification handshake can be completed early. A partial row has
-- NULL access_token/phone_number_id and status 'disconnected';
-- every consumer of access_token treats NULL credentials the same
-- as "no config row" (guards added in the same change).
--
-- ALTER ... DROP NOT NULL is idempotent. The UNIQUE index on
-- phone_number_id (migration 013) permits multiple NULLs, so
-- several accounts may hold partial rows simultaneously.
-- ============================================================

ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
