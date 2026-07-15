# WhatsApp Partial Config (Verify Token First) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow saving only the webhook verify token in Settings → WhatsApp (before having Meta credentials), so Facebook's webhook verification can succeed early; the full credential save flow stays intact.

**Architecture:** Migration 037 drops NOT NULL on `whatsapp_config.access_token`/`phone_number_id` so a "partial" row (encrypted verify_token, NULL credentials, status `disconnected`) can exist. The config POST gains a partial branch (no Meta validation); the config GET gains a `partial_config` state instead of misreporting "token corrupted". Every consumer that decrypts `access_token` extends its existing "no config row" guard to also treat NULL credentials as not-configured. The form gains a "Save verify token only" button. Spec: `docs/superpowers/specs/2026-07-14-whatsapp-partial-config-design.md`.

**Tech Stack:** Postgres migration, Next.js 16 route handlers, Supabase JS, vitest (chainable-mock pattern from `src/app/api/whatsapp/send/route.test.ts`), next-intl.

## Global Constraints

- Branch `feat/whatsapp-partial-config` (exists; spec committed there).
- No new npm dependencies. The FULL save path (Meta validation → encrypt → register → subscribe) must not change behavior.
- Partial-save trigger condition, exact: body has NO `access_token` and NO `phone_number_id` and a non-blank string `verify_token`. Any other incomplete body keeps today's 400 (`access_token and phone_number_id are required`).
- Partial rows: `status: 'disconnected'`, credentials NULL, `verify_token` encrypted with the existing `encrypt()` (same as full path — the webhook GET decrypts when comparing).
- Guard pattern (uniform, all 6 consumers): extend the existing `if (configError || !config)` to `if (configError || !config || !config.access_token || !config.phone_number_id)` — reusing each file's existing error response verbatim; no new messages.
- Style: `src/lib` + `src/app/api` = no semicolons/single quotes, EXCEPT files that already use semicolons (e.g. `src/app/api/whatsapp/react/route.ts`, `src/lib/whatsapp/send-message.ts` use semicolons — match each file's existing style). `src/components` = semicolons/double quotes.
- Commands from repo root: `npx vitest run <file>`, `npm run typecheck`, `npm run lint`, `npm run test` (note: 2 pre-existing date-utils failures are environmental, unrelated).
- Do not commit `package-lock.json`, `database-completa.sql`, `test-sms-webhook.mjs` (unrelated local files).

---

### Task 1: Migration 037 + NULL-credential guards in all consumers

**Files:**
- Create: `supabase/migrations/037_whatsapp_config_partial.sql`
- Modify: `src/lib/whatsapp/send-message.ts` (~line 257)
- Modify: `src/app/api/whatsapp/broadcast/route.ts` (~line 143)
- Modify: `src/app/api/whatsapp/media/[mediaId]/route.ts` (~line 58)
- Modify: `src/app/api/whatsapp/react/route.ts` (~line 118)
- Modify: `src/app/api/whatsapp/templates/sync/route.ts` (~line 159)
- Modify: `src/app/api/whatsapp/templates/submit/route.ts` (~line 157)
- Test: modify `src/app/api/whatsapp/send/route.test.ts`

**Interfaces:**
- Consumes: existing `whatsapp_config` schema and each route's existing not-configured error.
- Produces: DB accepts partial rows; every access_token consumer rejects them with its existing "not configured" error. Task 2 relies on the migration existing.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Extend the six guards**

In each file below, find the config fetch and extend its guard condition. The ONLY change per file is the `if` condition — keep each block's existing response body and status untouched.

`src/lib/whatsapp/send-message.ts` (fetch at ~251, guard at ~257):
```ts
  if (configError || !config || !config.access_token || !config.phone_number_id) {
```

`src/app/api/whatsapp/broadcast/route.ts` (~143):
```ts
    if (configError || !config || !config.access_token || !config.phone_number_id) {
```

`src/app/api/whatsapp/media/[mediaId]/route.ts` (~58):
```ts
    if (configError || !config || !config.access_token || !config.phone_number_id) {
```

`src/app/api/whatsapp/react/route.ts` (~118):
```ts
    if (configError || !config || !config.access_token || !config.phone_number_id) {
```

`src/app/api/whatsapp/templates/sync/route.ts` (~159):
```ts
    if (configError || !config || !config.access_token || !config.phone_number_id) {
```

`src/app/api/whatsapp/templates/submit/route.ts` (~157):
```ts
      if (configError || !config || !config.access_token || !config.phone_number_id) {
```

- [ ] **Step 3: Write the failing regression test**

In `src/app/api/whatsapp/send/route.test.ts`:

1. Near the other scenario toggles (after `let createdConversation ...`, ~line 21), add:

```ts
// Config row served by the whatsapp_config mock — tests can null out
// credentials to simulate a partial (verify-token-only) row.
let whatsappConfigRow: Record<string, unknown> | null = null

const DEFAULT_CONFIG_ROW = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
}
```

2. Replace the hardcoded `case 'whatsapp_config':` return with:

```ts
        case 'whatsapp_config':
          return { data: whatsappConfigRow, error: null }
```

3. In the `beforeEach`, add:

```ts
    whatsappConfigRow = { ...DEFAULT_CONFIG_ROW }
```

4. Add the test (inside the existing describe block):

```ts
  it('400s with not-configured when the config row is partial (verify token only)', async () => {
    whatsappConfigRow = {
      ...DEFAULT_CONFIG_ROW,
      access_token: null,
      phone_number_id: null,
    }
    existingConversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/not configured/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
```

- [ ] **Step 4: Run test to verify it fails (RED before Step 2's guard? No —)**

Order note: Steps 2 and 3 are independent files; for a true RED, run the new test with the guards NOT yet applied. If you already applied Step 2, temporarily verify RED by `git stash` of `src/lib/whatsapp/send-message.ts` is NOT worth it — instead apply Step 3 FIRST, run RED, then apply Step 2, run GREEN. Follow that order:

Run (before guards): `npx vitest run src/app/api/whatsapp/send/route.test.ts`
Expected: the new test FAILS (decrypt of null access_token throws → 500, or send proceeds — either way not a clean 400).

- [ ] **Step 5: Apply guards (Step 2's edits), run to verify GREEN**

Run: `npx vitest run src/app/api/whatsapp/send/route.test.ts`
Expected: ALL tests pass including the new one.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` → exit 0.

```bash
git add supabase/migrations/037_whatsapp_config_partial.sql src/lib/whatsapp/send-message.ts src/app/api/whatsapp/broadcast/route.ts "src/app/api/whatsapp/media/[mediaId]/route.ts" src/app/api/whatsapp/react/route.ts src/app/api/whatsapp/templates/sync/route.ts src/app/api/whatsapp/templates/submit/route.ts src/app/api/whatsapp/send/route.test.ts
git commit -m "feat: allow partial whatsapp_config rows; guard all access_token consumers"
```

---

### Task 2: Config API — partial POST branch + GET partial state

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (POST ~after line 188 body destructure; GET ~before line 114 decrypt)
- Test: create `src/app/api/whatsapp/config/route.test.ts`

**Interfaces:**
- Consumes: migration 037 (Task 1); existing `encrypt` from `@/lib/whatsapp/encryption`; existing `resolveAccountId`.
- Produces: `POST {verify_token}` → `{ success: true, saved: true, partial: true }`; `GET` on a partial row → `{ connected: false, reason: 'partial_config', verify_token_saved: true, message }`. Task 3's UI calls both.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/whatsapp/config/route.test.ts` (mirror the chainable-mock idiom of `send/route.test.ts`; this file uses no semicolons/single quotes like the route):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Partial-save path: POST with only { verify_token } stores the encrypted
// token without Meta validation; GET on a partial row reports
// reason 'partial_config' instead of token corruption.
// ---------------------------------------------------------------------------

const configInserts: Array<Record<string, unknown>> = []
const configUpdates: Array<Record<string, unknown>> = []
let existingConfigRow: Record<string, unknown> | null = null

function makeSupabaseMock() {
  function builder(table: string) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      maybeSingle: async () => {
        if (table === 'profiles') return { data: { account_id: 'acct-1' }, error: null }
        if (table === 'whatsapp_config') return { data: existingConfigRow, error: null }
        return { data: null, error: null }
      },
      insert: (row: Record<string, unknown>) => {
        configInserts.push(row)
        return { error: null }
      },
      update: (row: Record<string, unknown>) => {
        configUpdates.push(row)
        return { eq: () => ({ error: null }) }
      },
    }
    return chain
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => builder(table),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => supabaseMock,
}))

import { GET, POST } from './route'

function postConfig(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /api/whatsapp/config — partial save (verify token only)', () => {
  beforeEach(() => {
    configInserts.length = 0
    configUpdates.length = 0
    existingConfigRow = null
    supabaseMock = makeSupabaseMock()
    // 64-hex key so encrypt() works in-test.
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    // Any Meta call would be a bug on this path — make fetch explode.
    vi.stubGlobal('fetch', () => {
      throw new Error('unexpected network call on partial save')
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('inserts a partial row with the ENCRYPTED token and returns partial:true', async () => {
    const res = await postConfig({ verify_token: 'my-verify-token' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, saved: true, partial: true })
    expect(configInserts).toHaveLength(1)
    expect(configInserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      status: 'disconnected',
    })
    // Stored encrypted, never plaintext.
    expect(configInserts[0].verify_token).not.toBe('my-verify-token')
    expect(String(configInserts[0].verify_token).length).toBeGreaterThan(20)
  })

  it('updates the existing row instead of inserting when one exists', async () => {
    existingConfigRow = { id: 'cfg-1' }
    const res = await postConfig({ verify_token: 'rotated-token' })
    expect(res.status).toBe(200)
    expect(configInserts).toHaveLength(0)
    expect(configUpdates).toHaveLength(1)
    expect(configUpdates[0].verify_token).not.toBe('rotated-token')
  })

  it('keeps the existing 400 for other incomplete bodies', async () => {
    const res = await postConfig({ phone_number_id: 'PNID-1' })
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/access_token and phone_number_id are required/)
  })

  it('400s when verify_token is blank', async () => {
    const res = await postConfig({ verify_token: '   ' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/whatsapp/config — partial row', () => {
  beforeEach(() => {
    supabaseMock = makeSupabaseMock()
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    vi.stubGlobal('fetch', () => {
      throw new Error('unexpected network call for a partial row')
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('reports partial_config instead of token corruption', async () => {
    existingConfigRow = {
      phone_number_id: null,
      access_token: null,
      status: 'disconnected',
    }
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      connected: false,
      reason: 'partial_config',
      verify_token_saved: true,
    })
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts`
Expected: FAIL — partial-save tests get today's 400 (`access_token and phone_number_id are required`).

- [ ] **Step 3: Add the partial POST branch**

In `src/app/api/whatsapp/config/route.ts`, immediately AFTER the body destructure (`const { phone_number_id, waba_id, access_token, verify_token, pin } = body`) and BEFORE the `if (!access_token || !phone_number_id)` check, insert:

```ts
    // ── Partial save: verify token only ──────────────────────────────
    // Lets the operator store the webhook verify token BEFORE having
    // Meta credentials, so Facebook's "Verify and save" handshake can
    // succeed while the number is still being verified. The row stays
    // status='disconnected' with NULL credentials until the full save
    // below replaces it (migration 037 made the columns nullable).
    if (!access_token && !phone_number_id) {
      if (typeof verify_token !== 'string' || !verify_token.trim()) {
        return NextResponse.json(
          { error: 'access_token and phone_number_id are required' },
          { status: 400 }
        )
      }

      let encryptedVerifyToken: string
      try {
        encryptedVerifyToken = encrypt(verify_token.trim())
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown encryption error'
        console.error('Encryption failed:', message)
        return NextResponse.json(
          {
            error:
              'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
          },
          { status: 500 }
        )
      }

      const { data: existingRow } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .maybeSingle()

      const writeError = existingRow
        ? (
            await supabase
              .from('whatsapp_config')
              .update({
                verify_token: encryptedVerifyToken,
                updated_at: new Date().toISOString(),
              })
              .eq('account_id', accountId)
          ).error
        : (
            await supabase.from('whatsapp_config').insert({
              account_id: accountId,
              user_id: user.id,
              verify_token: encryptedVerifyToken,
              status: 'disconnected',
            })
          ).error

      if (writeError) {
        console.error('Error saving verify token:', writeError)
        return NextResponse.json(
          { error: 'Failed to save verify token' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, saved: true, partial: true })
    }
```

Note the 400-on-blank branch reuses the existing error text so other-incomplete-body behavior is unchanged.

- [ ] **Step 4: Add the GET partial branch**

In the GET handler, AFTER the `if (!config)` block and BEFORE the decrypt try/catch, insert:

```ts
    // Partial row (verify token saved before Meta credentials). Not an
    // error state — don't fall through to decrypt(null) which would
    // misreport this as token corruption with a Reset banner.
    if (!config.access_token || !config.phone_number_id) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'partial_config',
          verify_token_saved: true,
          message:
            'Verify token saved. Add your Phone Number ID and Access Token to finish connecting WhatsApp.',
        },
        { status: 200 }
      )
    }
```

- [ ] **Step 5: Run to verify GREEN + typecheck**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts` → all pass.
Run: `npm run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/config/route.ts src/app/api/whatsapp/config/route.test.ts
git commit -m "feat: partial WhatsApp config save (verify token only) + partial_config GET state"
```

---

### Task 3: Form button + i18n + full verification

**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx`
- Modify: `messages/en.json` (`Settings.whatsapp` section, near `webhookVerifyTokenHint` ~line 1462)

**Interfaces:**
- Consumes: Task 2's `POST {verify_token}` → `{ saved, partial }` contract.
- Produces: user-facing button. Nothing imports from it.

- [ ] **Step 1: Add i18n keys**

In `messages/en.json`, inside the `Settings.whatsapp` object, right after the `"webhookVerifyTokenHint"` entry, add:

```json
      "saveVerifyTokenOnly": "Save verify token only",
      "verifyTokenSaved": "Verify token saved. Paste the same token in Meta's webhook settings and click Verify and save.",
```

- [ ] **Step 2: Add state + handler in the form**

In `src/components/settings/whatsapp-config.tsx`:

1. Next to the other `useState` hooks (near `const [saving, setSaving] = useState(false);` — locate it), add:

```tsx
  const [savingToken, setSavingToken] = useState(false);
```

2. After the `handleSave` function, add:

```tsx
  // Partial save: store only the webhook verify token so the operator
  // can complete Facebook's webhook verification before having Meta
  // credentials (the full save still requires and validates them).
  async function handleSaveVerifyToken() {
    if (!verifyToken.trim()) return;
    try {
      setSavingToken(true);
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verify_token: verifyToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.saved) {
        toast.error(data.error ?? 'Failed to save verify token');
        return;
      }
      toast.success(t('verifyTokenSaved'));
    } catch {
      toast.error('Failed to save verify token');
    } finally {
      setSavingToken(false);
    }
  }
```

3. In the verify-token field's JSX (the `<div className="space-y-2">` containing `t('webhookVerifyToken')`), AFTER the hint `<p>` that renders `t('webhookVerifyTokenHint')`, add:

```tsx
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={savingToken || !verifyToken.trim()}
                onClick={handleSaveVerifyToken}
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {savingToken ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('saveVerifyTokenOnly')
                )}
              </Button>
```

(`Button` and `Loader2` are already imported in this file.)

No further status-display changes: the GET's `partial_config` payload flows through the existing disconnected-state message rendering, and it deliberately does NOT set `resetReason` (only `token_corrupted`/`meta_api_error` do), so the Reset banner stays hidden.

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → exit 0.
Run: `npm run lint` → exit 0, no new warnings in touched files.
Run: `npm run test` → all suites pass except the 2 pre-existing date-utils environmental failures.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx messages/en.json
git commit -m "feat: 'Save verify token only' button in WhatsApp settings"
```
