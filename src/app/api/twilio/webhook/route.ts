// ============================================================
// POST /api/twilio/webhook — Twilio inbound SMS.
//
// Twilio Console → phone number → Messaging → "A message comes in"
// → Webhook, URL https://<app-domain>/api/twilio/webhook, HTTP POST.
//
// Receive-only: validates X-Twilio-Signature, resolves the owning
// account, matches the sender against contacts, inserts into
// sms_messages, and answers the empty TwiML Twilio expects. Sending
// SMS is deliberately out of scope (see the 2026-07-14 design spec).
//
// Mirrors src/app/api/whatsapp/webhook/route.ts: raw body first,
// fail-closed when the secret is missing, lazy service-role client.
// Unlike Meta's webhook there is no GET verification handshake and
// no `after()` — processing is two reads + one insert, well inside
// Twilio's 15s timeout.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { parseInboundSms, pickSmsAccountId } from '@/lib/sms/inbound'
import { verifyTwilioSignature } from '@/lib/sms/twilio-signature'

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/** The ack Twilio expects: 200 + empty TwiML (we never auto-reply). */
function twimlResponse(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

/**
 * The URL Twilio signed. Twilio signs the URL configured in its
 * console — behind a proxy, `request.url` may disagree (http vs https,
 * internal host), so prefer the operator's canonical
 * NEXT_PUBLIC_SITE_URL + the request path, falling back to request.url
 * for bare deployments.
 */
function signedUrl(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!site) return request.url
  const { pathname, search } = new URL(request.url)
  return `${site}${pathname}${search}`
}

export async function POST(request: Request) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN
    if (!authToken) {
      // Fail closed, like the WhatsApp webhook with META_APP_SECRET:
      // without the token every payload is spoofable, so reject all.
      console.error(
        '[twilio-webhook] TWILIO_AUTH_TOKEN is not set — rejecting request. ' +
          'Configure it (Twilio Console → Account → Auth Token) to enable the SMS webhook.'
      )
      return NextResponse.json(
        { error: 'SMS webhook not configured' },
        { status: 503 }
      )
    }

    // Raw body first: the signature covers the exact decoded params.
    const rawBody = await request.text()
    const params = Object.fromEntries(new URLSearchParams(rawBody))

    const ok = verifyTwilioSignature({
      authToken,
      url: signedUrl(request),
      params,
      signatureHeader: request.headers.get('x-twilio-signature'),
    })
    if (!ok) {
      console.warn('[twilio-webhook] rejected request with invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 })
    }

    const sms = parseInboundSms(params)
    if (!sms) {
      return NextResponse.json(
        { error: 'Missing MessageSid, From or To' },
        { status: 400 }
      )
    }

    const db = supabaseAdmin()

    const { data: accounts, error: accountsError } = await db
      .from('accounts')
      .select('id')
    if (accountsError) {
      console.error('[twilio-webhook] failed to load accounts:', accountsError)
      return NextResponse.json(
        { error: 'Failed to resolve account' },
        { status: 500 }
      )
    }

    const resolution = pickSmsAccountId(
      ((accounts ?? []) as { id: string }[]).map((a) => a.id),
      process.env.TWILIO_SMS_ACCOUNT_ID
    )
    if ('error' in resolution) {
      console.error('[twilio-webhook] cannot resolve account:', resolution.error)
      return NextResponse.json(
        { error: 'Cannot resolve account' },
        { status: 500 }
      )
    }

    // Same matching the WhatsApp webhook uses (last-8-digit tolerant).
    const contact = await findExistingContact(db, resolution.accountId, sms.from)

    const { error: insertError } = await db.from('sms_messages').insert({
      account_id: resolution.accountId,
      contact_id: contact?.id ?? null,
      from_number: sms.from,
      to_number: sms.to,
      body: sms.body,
      twilio_sid: sms.twilioSid,
      num_media: sms.numMedia,
      media_urls: sms.mediaUrls,
    })

    if (insertError) {
      if (isUniqueViolation(insertError)) {
        // Twilio retried a message we already stored — ack so it stops.
        return twimlResponse()
      }
      console.error(
        `[twilio-webhook] insert failed for ${sms.twilioSid}:`,
        insertError
      )
      // Non-2xx → Twilio retries, which is what we want for transient
      // DB errors; the twilio_sid unique index keeps retries idempotent.
      return NextResponse.json(
        { error: 'Failed to store message' },
        { status: 500 }
      )
    }

    return twimlResponse()
  } catch (err) {
    console.error('[twilio-webhook] unhandled error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
