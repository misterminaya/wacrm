import { describe, expect, it } from 'vitest'
import { buildSmsSearchPattern, escapeIlike } from './search'

describe('escapeIlike', () => {
  it('escapes ilike wildcards and backslashes', () => {
    expect(escapeIlike('50%_off')).toBe('50\\%\\_off')
    expect(escapeIlike('a\\b')).toBe('a\\\\b')
  })

  it('strips PostgREST or() delimiters (commas and parens)', () => {
    expect(escapeIlike('a,b(c)d')).toBe('a b c d')
  })

  it('leaves digits, letters, + and spaces intact', () => {
    expect(escapeIlike('+51 999 Lili')).toBe('+51 999 Lili')
  })
})

describe('buildSmsSearchPattern', () => {
  it('returns null for empty or blank terms', () => {
    expect(buildSmsSearchPattern('')).toBeNull()
    expect(buildSmsSearchPattern('   ')).toBeNull()
  })

  it('returns null when the term is only stripped characters', () => {
    expect(buildSmsSearchPattern(',()')).toBeNull()
  })

  it('wraps the trimmed, escaped term in wildcards', () => {
    expect(buildSmsSearchPattern('+51 999')).toBe('%+51 999%')
    expect(buildSmsSearchPattern('  Lili  ')).toBe('%Lili%')
  })

  it('does not let user wildcards through unescaped', () => {
    expect(buildSmsSearchPattern('100%')).toBe('%100\\%%')
  })
})
