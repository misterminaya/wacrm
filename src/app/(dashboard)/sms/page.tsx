"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { buildSmsOrFilter, buildSmsSearchPattern } from "@/lib/sms/search";
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
  // Guards against out-of-order responses: rapid Next/Prev clicks or a page
  // click racing the 300ms debounce can let an older fetch resolve after a
  // newer one. Each load() call claims the next sequence number and only
  // applies its result if it's still the most recent call.
  const requestSeq = useRef(0);

  // Debounce the search box; a term change always jumps back to page 0.
  useEffect(() => {
    const id = setTimeout(() => {
      if (searchTerm === debouncedTerm) return;
      setDebouncedTerm(searchTerm);
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [searchTerm, debouncedTerm]);

  const load = useCallback(async () => {
    if (!accountId) return;
    const seq = ++requestSeq.current;
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
      if (seq !== requestSeq.current) return;
      const ids = (matched ?? []).map((c: { id: string }) => c.id);
      // The pattern is safe inside or(): escapeIlike strips , ( ) " and we
      // quote the value so spaces and + survive PostgREST parsing. PostgREST
      // also unescapes \x sequences inside quoted values, so buildSmsOrFilter
      // doubles the LIKE escape backslashes to survive that unescaping.
      query =
        ids.length > 0
          ? query.or(buildSmsOrFilter(pattern, ids))
          : query.ilike("from_number", pattern);
    }

    const { data, count, error: fetchErr } = await query
      .order("received_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (seq !== requestSeq.current) return;
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
              aria-label="Previous page"
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
              aria-label="Next page"
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
