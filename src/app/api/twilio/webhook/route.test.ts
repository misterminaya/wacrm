import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeTwilioSignature } from '@/lib/sms/twilio-signature'
import { POST } from './route'

const URL = 'https://crm.test/api/twilio/webhook'
const AUTH_TOKEN = 'twilio-test-token'

function twilioRequest(
  params: Record<string, string>,
  signature: string | null,
): Request {
  const body = new URLSearchParams(params).toString()
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature !== null) headers['x-twilio-signature'] = signature
  return new Request(URL, { method: 'POST', headers, body })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/twilio/webhook — no-database paths', () => {
  it('returns 503 when TWILIO_AUTH_TOKEN is not configured', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '')
    const res = await POST(twilioRequest({ MessageSid: 'SM1' }, 'whatever'))
    expect(res.status).toBe(503)
  })

  it('returns 403 for a missing signature header', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
    // NEXT_PUBLIC_SITE_URL unset → the route validates against request.url
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    const res = await POST(twilioRequest({ MessageSid: 'SM1' }, null))
    expect(res.status).toBe(403)
  })

  it('returns 403 for an invalid signature', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    const res = await POST(
      twilioRequest({ MessageSid: 'SM1' }, 'bogus-signature'),
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 for a validly-signed payload missing From/To', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    const params = { MessageSid: 'SM1' } // no From / To
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, params)
    const res = await POST(twilioRequest(params, sig))
    expect(res.status).toBe(400)
  })

  it('validates against NEXT_PUBLIC_SITE_URL when set (proxy-canonical URL)', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
    // Operator configured the canonical URL; Twilio signed that URL even
    // though the request object internally carries the same value here.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.test')
    const params = { MessageSid: 'SM1' }
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, params)
    const res = await POST(twilioRequest(params, sig))
    // Signature accepted → proceeds past 403 into payload validation (400).
    expect(res.status).toBe(400)
  })
})
