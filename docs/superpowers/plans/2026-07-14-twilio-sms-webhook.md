# Twilio Inbound SMS Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive inbound SMS from Twilio via a signed webhook, store them in a new `sms_messages` table, and show them in a new `/sms` dashboard section separate from the WhatsApp inbox.

**Architecture:** A new route handler `POST /api/twilio/webhook` validates Twilio's `X-Twilio-Signature` (HMAC-SHA1, no new dependencies), resolves the target account, matches the sender to an existing contact, and inserts into `sms_messages` (service-role client, dedupe on `twilio_sid`). A client-component page `/sms` lists messages grouped by sender. Spec: `docs/superpowers/specs/2026-07-14-twilio-sms-webhook-design.md`.

**Tech Stack:** Next.js 16 App Router route handlers (Web `Request`/`Response`), Supabase (`@supabase/supabase-js`), `node:crypto`, vitest, Tailwind + existing UI components, next-intl.

## Global Constraints

- Work on branch `feat/twilio-sms-webhook` (already exists, spec committed there).
- **No new npm dependencies.** Signature validation is hand-rolled with `node:crypto` (do NOT add the `twilio` package).
- Receive-only: no SMS sending anywhere. No settings UI. No realtime.
- New env vars, exact names: `TWILIO_AUTH_TOKEN` (required for webhook), `TWILIO_SMS_ACCOUNT_ID` (optional, only for multi-account installs).
- Migration must be idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), matching every existing file in `supabase/migrations/`.
- Follow existing repo idioms exactly: webhook route mirrors `src/app/api/whatsapp/webhook/route.ts` (raw-body-first, lazy admin client, fail-closed on missing secret); dashboard page mirrors `src/app/(dashboard)/notifications/page.tsx` (client component + `createClient()` from `@/lib/supabase/client` + `useAuth()`; RLS does the scoping).
- Next.js 16 note (per AGENTS.md, verified against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`): route handlers export `async function POST(request: Request)` and return Web `Response` objects — same as the existing webhook. No dynamic params involved here.
- Source files in `src/lib` and `src/app/api` use the repo's no-semicolon style with single quotes (see `src/lib/webhooks/deliver.ts`); `src/components` and `src/app/(dashboard)` pages use semicolons and double quotes (see `notifications/page.tsx`). Match the style of each file's directory.
- Commands: `npm run typecheck`, `npm run lint`, `npx vitest run <file>`. Run from repo root `/home/minaya/wacrm`.

---

### Task 1: Migration `036_sms_messages.sql`

**Files:**
- Create: `supabase/migrations/036_sms_messages.sql`

**Interfaces:**
- Consumes: `accounts`, `contacts` tables and `is_account_member(uuid, account_role_enum)` from migration `017_account_sharing.sql`.
- Produces: table `sms_messages` with columns `id, account_id, contact_id, from_number, to_number, body, twilio_sid, num_media, media_urls, received_at, created_at` — Task 4 inserts into it, Task 5 selects from it.

There is no local Postgres in this environment, so this task has no runnable test; correctness = matching the spec's SQL and the repo's idempotency conventions. The migration gets applied by the operator with `supabase db push` at deploy time.

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Sanity-check conventions against neighbors**

Run: `grep -c "IF NOT EXISTS" supabase/migrations/036_sms_messages.sql`
Expected: `3` (table + 2 indexes)

Run: `grep -c "DROP POLICY IF EXISTS" supabase/migrations/036_sms_messages.sql`
Expected: `2`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/036_sms_messages.sql
git commit -m "feat: add sms_messages table for Twilio inbound SMS"
```

---

### Task 2: Twilio signature validation library

**Files:**
- Create: `src/lib/sms/twilio-signature.ts`
- Test: `src/lib/sms/twilio-signature.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (`node:crypto` only).
- Produces:
  - `computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string` — base64 HMAC-SHA1 per Twilio's scheme.
  - `verifyTwilioSignature(args: { authToken: string; url: string; params: Record<string, string>; signatureHeader: string | null }): boolean` — timing-safe compare. Task 4's route calls only `verifyTwilioSignature`; `computeTwilioSignature` is exported so tests (including Task 4's route tests) can build valid signatures.

Twilio's algorithm (https://www.twilio.com/docs/usage/security#validating-requests): take the full URL Twilio requested, sort the POST parameter **names** alphabetically, append each name immediately followed by its value to the URL string, HMAC-SHA1 the result with the Auth Token as key, base64-encode, compare with the `X-Twilio-Signature` header.

- [ ] **Step 1: Write the failing test**

```ts
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  computeTwilioSignature,
  verifyTwilioSignature,
} from './twilio-signature'

const AUTH_TOKEN = 'test-auth-token-12345'
const URL = 'https://crm.example.com/api/twilio/webhook'

/**
 * Independent reference implementation: hand-concatenates the sorted
 * key+value pairs so a bug in computeTwilioSignature's sorting or
 * joining can't hide behind a shared helper.
 */
function referenceSignature(concatenated: string): string {
  return crypto
    .createHmac('sha1', AUTH_TOKEN)
    .update(concatenated, 'utf8')
    .digest('base64')
}

describe('computeTwilioSignature', () => {
  it('concatenates sorted param names + values after the URL', () => {
    // Insertion order deliberately unsorted (From before Body).
    const params = {
      From: '+15551234567',
      Body: 'Hello',
      MessageSid: 'SM123',
    }
    // Sorted: Body, From, MessageSid
    const expected = referenceSignature(
      URL + 'Body' + 'Hello' + 'From' + '+15551234567' + 'MessageSid' + 'SM123',
    )
    expect(computeTwilioSignature(AUTH_TOKEN, URL, params)).toBe(expected)
  })

  it('signs the bare URL when there are no params', () => {
    expect(computeTwilioSignature(AUTH_TOKEN, URL, {})).toBe(
      referenceSignature(URL),
    )
  })
})

describe('verifyTwilioSignature', () => {
  const params = { Body: 'Hi', From: '+15551234567', MessageSid: 'SM1' }
  const valid = () => computeTwilioSignature(AUTH_TOKEN, URL, params)

  it('accepts a valid signature', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signatureHeader: valid(),
      }),
    ).toBe(true)
  })

  it('rejects a missing header', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signatureHeader: null,
      }),
    ).toBe(false)
  })

  it('rejects a tampered signature of the same length', () => {
    const sig = valid()
    const tampered =
      (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signatureHeader: tampered,
      }),
    ).toBe(false)
  })

  it('rejects a signature of a different length without throwing', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signatureHeader: 'short',
      }),
    ).toBe(false)
  })

  it('rejects when params were altered after signing', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: { ...params, Body: 'Hi!' },
        signatureHeader: valid(),
      }),
    ).toBe(false)
  })

  it('rejects when the URL differs (e.g. http vs https)', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL.replace('https://', 'http://'),
        params,
        signatureHeader: valid(),
      }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sms/twilio-signature.test.ts`
Expected: FAIL — cannot resolve `./twilio-signature`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sms/twilio-signature.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sms/twilio-signature.ts src/lib/sms/twilio-signature.test.ts
git commit -m "feat: Twilio webhook signature validation (HMAC-SHA1, no new deps)"
```

---

### Task 3: Inbound SMS parsing + account resolution helpers

**Files:**
- Create: `src/lib/sms/inbound.ts`
- Test: `src/lib/sms/inbound.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 4's route imports all of these):
  - `interface InboundSms { twilioSid: string; from: string; to: string; body: string | null; numMedia: number; mediaUrls: string[] | null }`
  - `parseInboundSms(params: Record<string, string>): InboundSms | null` — null when `MessageSid`, `From`, or `To` is missing/blank.
  - `type SmsAccountResolution = { accountId: string } | { error: string }`
  - `pickSmsAccountId(accountIds: string[], envAccountId: string | undefined): SmsAccountResolution`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseInboundSms, pickSmsAccountId } from './inbound'

describe('parseInboundSms', () => {
  const base = {
    MessageSid: 'SM123',
    From: '+15551234567',
    To: '+15559876543',
    Body: 'Hello there',
    NumMedia: '0',
  }

  it('extracts the core fields', () => {
    expect(parseInboundSms(base)).toEqual({
      twilioSid: 'SM123',
      from: '+15551234567',
      to: '+15559876543',
      body: 'Hello there',
      numMedia: 0,
      mediaUrls: null,
    })
  })

  it.each(['MessageSid', 'From', 'To'] as const)(
    'returns null when %s is missing',
    (field) => {
      const params: Record<string, string> = { ...base }
      delete params[field]
      expect(parseInboundSms(params)).toBeNull()
    },
  )

  it('returns null when MessageSid is blank', () => {
    expect(parseInboundSms({ ...base, MessageSid: '   ' })).toBeNull()
  })

  it('stores a null body for body-less MMS', () => {
    const parsed = parseInboundSms({ ...base, Body: '' })
    expect(parsed?.body).toBeNull()
  })

  it('collects MediaUrl0..N for MMS', () => {
    const parsed = parseInboundSms({
      ...base,
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/media/0',
      MediaUrl1: 'https://api.twilio.com/media/1',
    })
    expect(parsed?.numMedia).toBe(2)
    expect(parsed?.mediaUrls).toEqual([
      'https://api.twilio.com/media/0',
      'https://api.twilio.com/media/1',
    ])
  })

  it('tolerates a garbage NumMedia', () => {
    const parsed = parseInboundSms({ ...base, NumMedia: 'banana' })
    expect(parsed?.numMedia).toBe(0)
    expect(parsed?.mediaUrls).toBeNull()
  })
})

describe('pickSmsAccountId', () => {
  it('prefers the env override when set', () => {
    expect(pickSmsAccountId(['a1', 'a2'], 'a2')).toEqual({ accountId: 'a2' })
  })

  it('uses the only account when exactly one exists', () => {
    expect(pickSmsAccountId(['a1'], undefined)).toEqual({ accountId: 'a1' })
  })

  it('errors when no accounts exist', () => {
    const res = pickSmsAccountId([], undefined)
    expect('error' in res).toBe(true)
  })

  it('errors when multiple accounts exist and no env override', () => {
    const res = pickSmsAccountId(['a1', 'a2'], undefined)
    expect('error' in res && res.error).toMatch(/TWILIO_SMS_ACCOUNT_ID/)
  })

  it('treats a blank env var as unset', () => {
    expect(pickSmsAccountId(['a1'], '  ')).toEqual({ accountId: 'a1' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sms/inbound.test.ts`
Expected: FAIL — cannot resolve `./inbound`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sms/inbound.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sms/inbound.ts src/lib/sms/inbound.test.ts
git commit -m "feat: inbound SMS parsing and account resolution helpers"
```

---

### Task 4: Webhook route `POST /api/twilio/webhook`

**Files:**
- Create: `src/app/api/twilio/webhook/route.ts`
- Test: `src/app/api/twilio/webhook/route.test.ts`

**Interfaces:**
- Consumes:
  - `verifyTwilioSignature`, `computeTwilioSignature` from `@/lib/sms/twilio-signature` (Task 2; `computeTwilioSignature` only in the test).
  - `parseInboundSms`, `pickSmsAccountId` from `@/lib/sms/inbound` (Task 3).
  - `findExistingContact(db, accountId, phone)` and `isUniqueViolation(error)` from `@/lib/contacts/dedupe` (existing).
  - Table `sms_messages` (Task 1).
- Produces: the public webhook endpoint. Nothing downstream imports from it.

The tests cover every path that does NOT need a database (missing token → 503, bad signature → 403, unparseable payload → 400): the admin client is lazily initialized, so those paths never touch Supabase. The happy path is exercised at deploy time with a real Twilio message (documented in the spec); the DB-free logic it composes is already unit-tested in Tasks 2–3.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/twilio/webhook/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the route**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/twilio/webhook/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/twilio/webhook/route.ts src/app/api/twilio/webhook/route.test.ts
git commit -m "feat: Twilio inbound SMS webhook endpoint"
```

---

### Task 5: `/sms` dashboard page + navigation + type

**Files:**
- Modify: `src/types/index.ts` (append the `SmsMessage` interface at the end)
- Create: `src/app/(dashboard)/sms/page.tsx`
- Modify: `src/components/layout/sidebar.tsx` (one nav item + one icon import)
- Modify: `src/components/layout/header.tsx` (one `pageTitles` entry)
- Modify: `messages/en.json` (one key in `"Sidebar"`, one in `"Header"`)

**Interfaces:**
- Consumes: table `sms_messages` (Task 1) via the browser Supabase client; `useAuth()` for `accountId`; RLS policy `sms_messages_select` does the scoping.
- Produces: `SmsMessage` type in `@/types`; user-facing page at `/sms`.

- [ ] **Step 1: Add the `SmsMessage` type**

Append to `src/types/index.ts` (follow the file's existing export style):

```ts
// Inbound SMS received via the Twilio webhook (receive-only — see
// docs/superpowers/specs/2026-07-14-twilio-sms-webhook-design.md).
export interface SmsMessage {
  id: string;
  account_id: string;
  contact_id: string | null;
  from_number: string;
  to_number: string;
  body: string | null;
  twilio_sid: string;
  num_media: number;
  media_urls: string[] | null;
  received_at: string;
  created_at: string;
  /** Joined contact row (select alias), when the sender matched. */
  contact?: { id: string; name: string | null } | null;
}
```

- [ ] **Step 2: Create the page**

`src/app/(dashboard)/sms/page.tsx` — client component, same skeleton as `notifications/page.tsx` (load on mount via browser client, RLS scopes to the member's account):

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { SmsMessage } from "@/types";
import { Loader2, MessageSquareText, Paperclip } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface SenderGroup {
  fromNumber: string;
  contactName: string | null;
  messages: SmsMessage[]; // chronological (oldest first)
  latestAt: string;
}

/** Group a reverse-chronological page of SMS by sender number. */
function groupBySender(messages: SmsMessage[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  for (const msg of messages) {
    let group = groups.get(msg.from_number);
    if (!group) {
      group = {
        fromNumber: msg.from_number,
        contactName: msg.contact?.name ?? null,
        messages: [],
        latestAt: msg.received_at,
      };
      groups.set(msg.from_number, group);
    }
    group.messages.push(msg);
    if (msg.received_at > group.latestAt) group.latestAt = msg.received_at;
    if (!group.contactName && msg.contact?.name) {
      group.contactName = msg.contact.name;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      messages: [...g.messages].sort((a, b) =>
        a.received_at.localeCompare(b.received_at),
      ),
    }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

export default function SmsPage() {
  const { accountId } = useAuth();
  const [messages, setMessages] = useState<SmsMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data, error: fetchErr } = await supabase
      .from("sms_messages")
      .select("*, contact:contacts(id, name)")
      .eq("account_id", accountId)
      .order("received_at", { ascending: false })
      .limit(500);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setMessages((data ?? []) as SmsMessage[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const groups = useMemo(
    () => (messages ? groupBySender(messages) : []),
    [messages],
  );

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Failed to load SMS: {error}
      </div>
    );
  }

  if (messages === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageSquareText className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">No SMS received yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Point your Twilio number&apos;s &quot;A message comes in&quot;
          webhook at <code>/api/twilio/webhook</code> and inbound SMS will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 lg:p-6">
      {groups.map((group) => (
        <section
          key={group.fromNumber}
          className="rounded-lg border border-border bg-card"
        >
          <header className="flex items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">
                {group.contactName ?? group.fromNumber}
              </h2>
              {group.contactName && (
                <p className="text-xs text-muted-foreground">
                  {group.fromNumber}
                </p>
              )}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(group.latestAt), {
                addSuffix: true,
              })}
            </span>
          </header>
          <ul className="divide-y divide-border">
            {group.messages.map((msg) => (
              <li key={msg.id} className="px-4 py-3">
                <p className="whitespace-pre-wrap break-words text-sm">
                  {msg.body ?? (
                    <span className="italic text-muted-foreground">
                      (no text)
                    </span>
                  )}
                </p>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <time dateTime={msg.received_at}>
                    {format(new Date(msg.received_at), "PPp")}
                  </time>
                  {msg.num_media > 0 && (
                    <span className="flex items-center gap-1">
                      <Paperclip className="h-3 w-3" />
                      {(msg.media_urls ?? []).map((url, i) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          media {i + 1}
                        </a>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add the sidebar nav item**

In `src/components/layout/sidebar.tsx`:
1. Add `MessageSquareText` to the existing `lucide-react` import.
2. In the `navItems` array, insert after the `/inbox` entry:

```ts
  { href: "/sms", labelKey: "sms", icon: MessageSquareText },
```

- [ ] **Step 4: Add the header title mapping**

In `src/components/layout/header.tsx`, inside `pageTitles`, insert after the `"/inbox"` entry:

```ts
  "/sms": "sms",
```

- [ ] **Step 5: Add the i18n keys**

In `messages/en.json`, add `"sms": "SMS"` to BOTH the `"Sidebar"` section (after `"inbox"`) and the `"Header"` section (after `"inbox"`). Example for the Sidebar section:

```json
    "inbox": "Inbox",
    "sms": "SMS",
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0 (no new warnings/errors).

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts "src/app/(dashboard)/sms/page.tsx" src/components/layout/sidebar.tsx src/components/layout/header.tsx messages/en.json
git commit -m "feat: SMS dashboard section listing Twilio inbound messages"
```

---

### Task 6: Env var docs + full verification

**Files:**
- Modify: `.env.local.example` (append a Twilio section under OPTIONAL)

**Interfaces:**
- Consumes: env var names from Tasks 3–4 (`TWILIO_AUTH_TOKEN`, `TWILIO_SMS_ACCOUNT_ID`).
- Produces: operator documentation; nothing imports it.

- [ ] **Step 1: Document the env vars**

Append to the `OPTIONAL` section of `.env.local.example`:

```bash
# ------------------------------------------------------------------
# Twilio inbound SMS (optional)
# ------------------------------------------------------------------
# Auth Token from Twilio Console → Account → API keys & tokens. Used
# to validate the X-Twilio-Signature header on POST /api/twilio/webhook
# (Twilio Console → your number → Messaging → "A message comes in" →
# Webhook → https://<your-domain>/api/twilio/webhook, HTTP POST).
# Without it the SMS webhook rejects every request (fail closed).
# TWILIO_AUTH_TOKEN=your-twilio-auth-token

# Only needed when the instance has MORE than one account: the id of
# the account that receives inbound SMS. With a single account (the
# normal self-hosted setup) it is resolved automatically.
# TWILIO_SMS_ACCOUNT_ID=account-uuid
```

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: all suites pass, including the three new test files.

- [ ] **Step 3: Typecheck + lint once more**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add .env.local.example
git commit -m "docs: document Twilio SMS env vars"
```

---

## Deploy-time checklist (operator, not part of implementation)

1. Apply the migration: `supabase db push` (or run `036_sms_messages.sql` against the instance).
2. Set `TWILIO_AUTH_TOKEN` in the deployment env.
3. Twilio Console → number → Messaging → "A message comes in" → Webhook `https://<domain>/api/twilio/webhook`, HTTP POST; leave "Primary handler fails" empty.
4. Send a test SMS to the Twilio number and confirm it appears at `/sms`.
