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
    expect(Object.keys(configUpdates[0]).sort()).toEqual(['updated_at', 'verify_token'])
  })

  it('keeps the existing 400 for other incomplete bodies', async () => {
    const res = await postConfig({ phone_number_id: 'PNID-1' })
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/access_token and phone_number_id are required/)
  })

  it('400s on the asymmetric incomplete body (access_token alone)', async () => {
    const res = await postConfig({ access_token: 'x' })
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
      verify_token: 'enc-something',
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
