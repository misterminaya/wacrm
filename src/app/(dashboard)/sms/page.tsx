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
