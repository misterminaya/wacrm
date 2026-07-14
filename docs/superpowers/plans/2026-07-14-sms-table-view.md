# SMS Paginated Table View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/sms` grouped-cards view with a server-side-paginated table (25 rows/page) with a debounced search box that filters by sender number or contact name.

**Architecture:** A pure, tested helper (`src/lib/sms/search.ts`) centralizes ilike-escaping and search-pattern building. The page component is rewritten to mirror the `contacts/page.tsx` pagination idiom (`{ count: "exact" }` + `.range()`, ChevronLeft/Right pager) using the existing `src/components/ui/table.tsx` components. Search runs server-side: contact-name matches are resolved to `contact_id`s first, then OR-combined with a `from_number ilike` filter. Spec: `docs/superpowers/specs/2026-07-14-sms-table-view-design.md`.

**Tech Stack:** Next.js 16 client component, Supabase JS (PostgREST filters), vitest, existing UI components (Table, Input, Button), lucide-react icons, date-fns.

## Global Constraints

- Work on branch `feat/sms-table-view` (already exists, spec committed there).
- No new npm dependencies. No DB/schema, webhook, `@/types`, or navigation changes.
- `PAGE_SIZE = 25`. Order: `received_at` descending. Search debounce: 300 ms; changing the term resets to page 0.
- Out of scope (do NOT add): realtime, SMS sending, row deletion, column sorting, row selection, i18n of the page's texts (they stay hardcoded English like today).
- Style: `src/lib` files use no semicolons + single quotes; `src/app/(dashboard)` files use semicolons + double quotes.
- The two-step search: (1) `contacts` where `name ilike pattern` (same account, limit 50) → ids; (2) `sms_messages` filtered by `.or('from_number.ilike."<pattern>",contact_id.in.(<ids>)')` when ids exist, else plain `.ilike("from_number", pattern)`. The pattern is safe inside `.or()` only because `escapeIlike` strips `,` `(` `)` and the pattern is wrapped in double quotes in the `.or()` string.
- Commands from repo root: `npx vitest run <file>`, `npm run typecheck`, `npm run lint`.

---

### Task 1: Search helper `src/lib/sms/search.ts`

**Files:**
- Create: `src/lib/sms/search.ts`
- Test: `src/lib/sms/search.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 2 imports these):
  - `escapeIlike(term: string): string`
  - `buildSmsSearchPattern(term: string): string | null` — `null` for empty/blank input, otherwise `` `%${escaped-and-trimmed}%` ``.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sms/search.test.ts`
Expected: FAIL — cannot resolve `./search`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

Note: `escapeIlike('a,b(c)d')` → after comma/paren strip: `a b c d` (the `\s+` collapse turns `b c ` + `d` runs into single spaces, and the test string yields exactly `a b c d`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sms/search.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sms/search.ts src/lib/sms/search.test.ts
git commit -m "feat: ilike-safe search pattern helper for SMS table"
```

---

### Task 2: Rewrite `/sms` page as paginated table with search

**Files:**
- Rewrite: `src/app/(dashboard)/sms/page.tsx` (replace the entire file)

**Interfaces:**
- Consumes: `buildSmsSearchPattern` from `@/lib/sms/search` (Task 1); `SmsMessage` from `@/types` (exists); UI components `Table, TableBody, TableCell, TableHead, TableHeader, TableRow` from `@/components/ui/table`, `Input` from `@/components/ui/input`, `Button` from `@/components/ui/button` (all exist); `createClient` from `@/lib/supabase/client`; `useAuth` from `@/hooks/use-auth`.
- Produces: user-facing page only; nothing imports from it.

- [ ] **Step 1: Replace the page component**

Full new content of `src/app/(dashboard)/sms/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { buildSmsSearchPattern } from "@/lib/sms/search";
import type { SmsMessage } from "@/types";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquareText,
  Paperclip,
  Search,
} from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 25;

export default function SmsPage() {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<SmsMessage[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box; a term change always jumps back to page 0.
  useEffect(() => {
    const id = setTimeout(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDebouncedTerm(searchTerm);
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [searchTerm]);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const pattern = buildSmsSearchPattern(debouncedTerm);

    let query = supabase
      .from("sms_messages")
      .select("*, contact:contacts(id, name)", { count: "exact" })
      .eq("account_id", accountId);

    if (pattern) {
      // Two-step search: resolve contact-name matches to ids first, then
      // OR them with the number filter. contact_id is stamped on each row
      // by the webhook, so name search costs one extra small query.
      const { data: matched } = await supabase
        .from("contacts")
        .select("id")
        .eq("account_id", accountId)
        .ilike("name", pattern)
        .limit(50);
      const ids = (matched ?? []).map((c: { id: string }) => c.id);
      // The pattern is safe inside or(): escapeIlike strips , ( ) and we
      // quote the value so spaces and + survive PostgREST parsing.
      query =
        ids.length > 0
          ? query.or(
              `from_number.ilike."${pattern}",contact_id.in.(${ids.join(",")})`,
            )
          : query.ilike("from_number", pattern);
    }

    const { data, count, error: fetchErr } = await query
      .order("received_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setError(null);
    setRows((data ?? []) as SmsMessage[]);
    setTotalCount(count ?? 0);
  }, [accountId, page, debouncedTerm]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasPrev = page > 0;
  const hasNext = page < totalPages - 1;
  const searching = buildSmsSearchPattern(debouncedTerm) !== null;

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Failed to load SMS: {error}
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0 && !searching) {
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
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by number or contact…"
            className="pl-8"
          />
        </div>
        <p className="shrink-0 text-xs text-muted-foreground">
          {totalCount} {totalCount === 1 ? "message" : "messages"}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          No messages match your search.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">From</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="w-44">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((msg) => (
                <TableRow key={msg.id}>
                  <TableCell className="align-top">
                    {msg.contact?.name ? (
                      <>
                        <p className="truncate text-sm font-medium">
                          {msg.contact.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {msg.from_number}
                        </p>
                      </>
                    ) : (
                      <p className="truncate text-sm">{msg.from_number}</p>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <p className="max-w-md truncate text-sm">
                      {msg.body ?? (
                        <span className="italic text-muted-foreground">
                          (no text)
                        </span>
                      )}
                    </p>
                    {msg.num_media > 0 && (
                      <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip className="h-3 w-3" />
                        {(msg.media_urls ?? []).map((url, i) => (
                          <a
                            key={`${msg.id}-${i}`}
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
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                    <time dateTime={msg.received_at}>
                      {format(new Date(msg.received_at), "PPp")}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, totalCount)} of {totalCount}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no new warnings in touched files.

- [ ] **Step 3: Run the SMS test suites (regression)**

Run: `npx vitest run src/lib/sms/ src/app/api/twilio/webhook/route.test.ts`
Expected: all pass (search helper 7, signature 8, inbound 16, route 5).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/sms/page.tsx"
git commit -m "feat: SMS page as paginated table with number/contact search"
```
