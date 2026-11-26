// To read (stage 38 step 6, ADR 0708): the procedures I must read and have not confirmed, oldest
// first, each with the version to read and since when, and what I have confirmed and when. One
// opens in the reader (knowledge-procedures), which has Confirm at its end; once confirmed it
// leaves the list. Declared as the admin's To read screen, for every staff account, pack roles
// included.
//
// What is mine to read is the host's answer (`ack.mine`, through the pack's `toRead`): who must
// read each procedure, which version, and whether a confirmation counts. This shows it.
import type { KnowledgeHooks } from "@composable-os/pack-knowledge/client";
import { dayWords, knowledgeRefusal, versionLine } from "@composable-os/pack-knowledge/client";
import { useState } from "react";
import { ProcedureReader, type ReaderHooks } from "../knowledge-procedures/procedures.tsx";
import { Button } from "../ui-button/button.tsx";

export type ToReadHooks = ReaderHooks & Pick<KnowledgeHooks, "useToRead">;

export function ToRead({
  knowledge,
  locale,
  mediaBase,
  mediaUrl,
}: {
  knowledge: ToReadHooks;
  locale?: string;
  mediaBase?: string;
  mediaUrl?: (id: string, width: number) => string;
}) {
  const mine = knowledge.useToRead();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <ProcedureReader
        knowledge={knowledge}
        id={open}
        onBack={() => {
          setOpen(null);
          void mine.refetch?.();
        }}
        {...(locale ? { locale } : {})}
        {...(mediaBase ? { mediaBase } : {})}
        {...(mediaUrl ? { mediaUrl } : {})}
      />
    );
  }
  if (mine.isPending) return <p aria-busy="true">Loading what you have to read…</p>;
  if (mine.error) {
    const refusal = knowledgeRefusal(mine.error);
    return (
      <p role="alert" data-refusal={refusal.kind}>
        {refusal.message}
      </p>
    );
  }
  const toRead = mine.data?.toRead ?? [];
  const confirmed = mine.data?.confirmed ?? [];
  return (
    <div className="grid max-w-3xl gap-6">
      <section aria-label="To read" className="grid gap-2">
        <h2 className="text-lg font-semibold">To read</h2>
        {toRead.length ? (
          <ul className="grid gap-2">
            {toRead.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                data-to-read={p.id}
              >
                <div className="grid gap-1">
                  <span className="font-medium">{p.title ?? "Untitled"}</span>
                  <span className="text-xs text-muted-foreground">
                    {versionLine(p.version, p.publishedAt, locale)} · to read since{" "}
                    {dayWords(p.since, locale)}
                  </span>
                </div>
                <Button
                  type="button"
                  onClick={() => setOpen(p.id)}
                  aria-label={`Read ${p.title ?? "the procedure"}`}
                >
                  Read
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">Nothing to read: you are up to date.</p>
        )}
      </section>
      {confirmed.length ? (
        <section aria-label="Confirmed" className="grid gap-2">
          <h2 className="text-lg font-semibold">Confirmed</h2>
          <ul className="grid gap-2">
            {confirmed.map((p) => (
              <li key={p.id} className="rounded-md border p-3" data-confirmed-item={p.id}>
                <button
                  type="button"
                  className="grid gap-1 text-left"
                  onClick={() => setOpen(p.id)}
                  aria-label={`Open ${p.title ?? "the procedure"}`}
                >
                  <span className="font-medium">{p.title ?? "Untitled"}</span>
                  <span className="text-xs text-muted-foreground">
                    Confirmed on {dayWords(p.confirmedAt, locale)}: counts for version {p.version}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
