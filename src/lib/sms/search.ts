/**
 * Search helpers for the /sms table view. Pure string functions so the
 * escaping rules are unit-testable — the page wires them to PostgREST.
 */

/**
 * Make a user-typed term safe inside an `ilike` pattern that may also be
 * embedded in a PostgREST `.or()` expression:
 *   - `,` `(` `)` would break `.or()` syntax → replaced with spaces
 *     (they never appear in real phone numbers or names);
 *   - `\`, `%`, `_` are LIKE metacharacters → escaped.
 * Order matters: backslashes must be doubled before adding escape
 * backslashes for % and _.
 */
export function escapeIlike(term: string): string {
  return term
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

/**
 * Build the `%…%` ilike pattern for a search box term, or null when the
 * term is effectively empty (blank, or nothing left after stripping).
 * The same pattern is used against `sms_messages.from_number` and
 * `contacts.name`.
 */
export function buildSmsSearchPattern(term: string): string | null {
  const cleaned = escapeIlike(term).trim()
  if (!cleaned) return null
  return `%${cleaned}%`
}
