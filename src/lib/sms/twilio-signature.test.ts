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
