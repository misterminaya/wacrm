import crypto from 'node:crypto'

/**
 * Twilio webhook signature scheme
 * (https://www.twilio.com/docs/usage/security#validating-requests):
 *
 *   1. Start with the full URL Twilio requested (scheme, host, path,
 *      query string).
 *   2. Sort the POST parameter names alphabetically and append each
 *      name immediately followed by its value.
 *   3. HMAC-SHA1 the resulting string with the account's Auth Token
 *      as key, base64-encode.
 *   4. Twilio sends the same value in the `X-Twilio-Signature` header.
 *
 * Implemented with node:crypto instead of the `twilio` npm package on
 * purpose — validating a signature does not justify a new dependency
 * in a self-hosted template (smaller supply-chain surface).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

/**
 * Timing-safe verification of an `X-Twilio-Signature` header. Same
 * shape as `verifyMetaWebhookSignature` (the WhatsApp equivalent):
 * missing header → false, length mismatch → false (timingSafeEqual
 * throws on unequal lengths), otherwise constant-time compare.
 */
export function verifyTwilioSignature(args: {
  authToken: string
  url: string
  params: Record<string, string>
  signatureHeader: string | null
}): boolean {
  const { authToken, url, params, signatureHeader } = args
  if (!signatureHeader) return false

  const expected = computeTwilioSignature(authToken, url, params)
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
