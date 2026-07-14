/**
 * Pure helpers for the Twilio inbound-SMS webhook. Kept free of I/O so
 * they unit-test without a database — the route in
 * src/app/api/twilio/webhook/route.ts wires them to Supabase.
 */

export interface InboundSms {
  twilioSid: string
  from: string
  to: string
  body: string | null
  numMedia: number
  mediaUrls: string[] | null
}

/**
 * Extract the fields we store from Twilio's form-encoded webhook
 * payload. Returns null when the required identifiers are missing —
 * the route turns that into a 400.
 */
export function parseInboundSms(
  params: Record<string, string>,
): InboundSms | null {
  const twilioSid = params.MessageSid?.trim()
  const from = params.From?.trim()
  const to = params.To?.trim()
  if (!twilioSid || !from || !to) return null

  const parsed = Number.parseInt(params.NumMedia ?? '0', 10)
  const numMedia = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed

  const mediaUrls: string[] = []
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`]
    if (url) mediaUrls.push(url)
  }

  return {
    twilioSid,
    from,
    to,
    body: params.Body?.trim() ? params.Body : null,
    numMedia,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
  }
}

export type SmsAccountResolution = { accountId: string } | { error: string }

/**
 * Decide which account owns inbound SMS. Env override first; then the
 * single-account fast path (the common self-hosted case); anything
 * ambiguous is an explicit, loggable error rather than a guess.
 */
export function pickSmsAccountId(
  accountIds: string[],
  envAccountId: string | undefined,
): SmsAccountResolution {
  const fromEnv = envAccountId?.trim()
  if (fromEnv) return { accountId: fromEnv }
  if (accountIds.length === 1) return { accountId: accountIds[0] }
  if (accountIds.length === 0) return { error: 'no accounts exist yet' }
  return {
    error:
      'multiple accounts exist — set TWILIO_SMS_ACCOUNT_ID to the account that should receive SMS',
  }
}
