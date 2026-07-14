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
