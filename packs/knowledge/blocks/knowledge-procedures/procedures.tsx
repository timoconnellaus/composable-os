// Procedures for staff (stage 38 step 6, ADR 0708): every published procedure, by section, with
// search, and the reader: one procedure in the wording last published ("Version 4, published
// 3 March 2026"), never the draft, with "I have read and understood this" at its end when it is
// the reader's to confirm. Declared as the admin's Procedures screen (and, as `ProcedureScreen`,
// the record screen a notice's link opens), so every staff account sees it, pack roles included.
//
// The host decides everything here (ADRs 0701, 0702): what is published and its version, who
// must read it, whether a confirmation counts, and whether one is allowed at all. The button
// confirms the version on screen, the one the person was shown, never the version their list
// names; a refusal (a newer version published meanwhile, already confirmed) is shown, never taken
// as done. Rich text is drawn by the Content pack's renderer only: nothing here is HTML.
//
// Each procedure's section is what the host gives with it (`names.section`: its id, name and order, ADR 0708), so no
// account, a coach's or a cleaner's included, asks for sections. A pack-role account is not
// served a procedure's pictures (the host's media rule): the reader asks for none for it (the
// procedure's `pictures` answer says so) and says in each one's place that it cannot be shown.

import { mediaPath, type RichText as RichTextValue } from "@composable-os/pack-content/client";
import type {
  KnowledgeHooks,
  KnowledgeRefusal,
  Published,
  SearchHit,
  Segment,
} from "@composable-os/pack-knowledge/client";
import {
  bySection,
  confirmLabel,
  dayWords,
  knowledgeRefusal,
  myStanding,
  sectionOf,
  titleOf,
  versionLine,
} from "@composable-os/pack-knowledge/client";
import { useEffect, useId, useState } from "react";
import { RichText } from "../content-rich-text/rich-text.tsx";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";

export type ReaderHooks = Pick<KnowledgeHooks, "useProcedure" | "useToRead" | "useConfirm">;
export type ProceduresHooks = ReaderHooks &
  Pick<KnowledgeHooks, "useProcedures" | "useSearchProcedures">;

type MediaUrl = (id: string, width: number) => string;

/** A value that follows `value` once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A highlighted line from search: matching words marked, every word React text. */
export function Highlight({ segments }: { segments: readonly Segment[] | null | undefined }) {
  return (
    <>
      {(segments ?? []).map((s, i) =>
        s.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
          <mark key={i} className="rounded-sm bg-accent px-0.5 text-accent-foreground">
            {s.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * A picture in the procedure, or a line in its place when the host does not serve it: not asked
 * for at all when the host said it will not serve this reader its pictures (`served` false).
 */
function Picture({
  media,
  alt,
  mediaUrl,
  served,
}: {
  media: string;
  alt: string;
  mediaUrl: MediaUrl;
  served: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || !served) {
    return (
      <figure data-block="image" data-unavailable="">
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          This picture cannot be shown here{alt ? `: ${alt}` : ""}.
        </p>
      </figure>
    );
  }
  return (
    <figure data-block="image">
      <img
        src={mediaUrl(media, 960)}
        alt={alt}
        loading="lazy"
        className="w-full rounded-lg"
        onError={() => setFailed(true)}
      />
    </figure>
  );
}

/** The panel at the end of the procedure: confirm it, or where it stands for me. */
function ConfirmPanel({
  knowledge,
  procedure,
  title,
  onReload,
  locale,
}: {
  knowledge: Pick<ReaderHooks, "useToRead" | "useConfirm">;
  procedure: Published & { version: number };
  title: string;
  onReload: () => void;
  locale?: string;
}) {
  const mine = knowledge.useToRead();
  const confirm = knowledge.useConfirm();
  const [done, setDone] = useState<{ version: number; confirmedAt: string } | null>(null);
  const [refusal, setRefusal] = useState<KnowledgeRefusal | null>(null);
  // Another procedure, or another version of it: nothing said about the last one carries over.
  const shown = `${procedure.id}:${procedure.version}`;
  const [said, setSaid] = useState(shown);
  if (said !== shown) {
    setSaid(shown);
    setDone(null);
    setRefusal(null);
  }

  async function onConfirm() {
    setRefusal(null);
    try {
      // The version on screen: the one this person was shown, never the one their list names.
      const out = await confirm.mutateAsync({ id: procedure.id, version: procedure.version });
      setDone({ version: out.version, confirmedAt: out.confirmedAt });
    } catch (error) {
      setRefusal(knowledgeRefusal(error));
    }
    await mine.refetch?.();
  }

  if (done) {
    return (
      <p role="status" className="rounded-md border p-3" data-confirmed={done.version}>
        Confirmed: you have read and understood version {done.version}, on{" "}
        {dayWords(done.confirmedAt, locale)}.
      </p>
    );
  }
  if (mine.isPending) return <p aria-busy="true">Checking whether this is yours to confirm…</p>;
  if (mine.error) {
    return (
      <p role="alert" data-refusal={knowledgeRefusal(mine.error).kind}>
        {knowledgeRefusal(mine.error).message}
      </p>
    );
  }
  const standing = myStanding(mine.data, procedure.id, procedure.version);
  return (
    <section aria-label="Read and understood" className="grid gap-2 rounded-md border p-3">
      {standing.kind === "to_read" ? (
        <>
          <p>
            You are asked to confirm that you have read and understood this procedure (to read since{" "}
            {dayWords(standing.since, locale)}).
          </p>
          <div>
            <Button
              type="button"
              disabled={confirm.isPending}
              aria-busy={confirm.isPending}
              onClick={onConfirm}
            >
              {confirmLabel(title, procedure.version)}
            </Button>
          </div>
        </>
      ) : null}
      {standing.kind === "newer" ? (
        <>
          <p>
            Version {standing.version} has been published since you opened this one. Read it before
            you confirm.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={onReload}>
              Read version {standing.version}
            </Button>
          </div>
        </>
      ) : null}
      {standing.kind === "confirmed" ? (
        <p data-confirmed={standing.version}>
          You confirmed this procedure on {dayWords(standing.confirmedAt, locale)}: it counts for
          version {standing.version}.
        </p>
      ) : null}
      {standing.kind === "not_asked" ? (
        <p className="text-muted-foreground">You are not asked to confirm this procedure.</p>
      ) : null}
      {refusal ? (
        <div role="alert" data-refusal={refusal.kind} className="grid gap-2">
          <p>{refusal.message}</p>
          {refusal.kind === "not_current" ? (
            <div>
              <Button type="button" variant="outline" onClick={onReload}>
                Read the new version
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One procedure as published, with Confirm at its end when it is the reader's to confirm. `anchor`
 * opens it at a section (a search result's, a citation's).
 */
export function ProcedureReader({
  knowledge,
  id,
  anchor,
  onBack,
  locale,
  mediaBase = "",
  mediaUrl = (media, width) => mediaPath(media, width, mediaBase),
}: {
  knowledge: ReaderHooks;
  id: string;
  anchor?: string;
  onBack?: () => void;
  locale?: string;
  /** Another origin for the pictures than this site's /api/media route. */
  mediaBase?: string;
  mediaUrl?: MediaUrl;
}) {
  const answer = knowledge.useProcedure({ id });
  const headingId = useId();
  const data = answer.data;
  useEffect(() => {
    if (!anchor || !data) return;
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [anchor, data]);

  const back = onBack ? (
    <div>
      <Button type="button" variant="outline" onClick={onBack}>
        All procedures
      </Button>
    </div>
  ) : null;
  if (answer.isPending) return <p aria-busy="true">Loading the procedure…</p>;
  if (answer.error || !data || data.version === undefined) {
    const refusal = knowledgeRefusal(answer.error);
    return (
      <div className="grid gap-3">
        {back}
        <p role="alert" data-refusal={refusal.kind}>
          {refusal.kind === "not_found" || !answer.error
            ? "This procedure is not published, or it has been unpublished."
            : refusal.message}
        </p>
      </div>
    );
  }
  const title = titleOf(data);
  const section = sectionOf(data);
  const summary = typeof data.values.summary === "string" ? data.values.summary : null;
  const version = data.version;
  return (
    <article
      className="grid max-w-3xl gap-4"
      aria-labelledby={headingId}
      data-procedure={data.id}
      data-version={version}
    >
      {back}
      <header className="grid gap-1">
        {section ? (
          <p className="text-sm text-muted-foreground" data-section="">
            {section}
          </p>
        ) : null}
        <h1 id={headingId} className="text-2xl font-semibold">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground" data-version-line="">
          {versionLine(version, data.publishedAt, locale)}
        </p>
        {summary ? <p>{summary}</p> : null}
      </header>
      <RichText
        value={data.values.body as RichTextValue | null}
        mediaUrl={mediaUrl}
        components={{
          image: ({ block }) => (
            <Picture
              media={block.media}
              alt={block.alt}
              mediaUrl={mediaUrl}
              served={data.pictures !== false}
            />
          ),
        }}
      />
      <ConfirmPanel
        knowledge={knowledge}
        procedure={{ ...data, version }}
        title={title}
        locale={locale ?? "en-AU"}
        onReload={() => void answer.refetch?.()}
      />
    </article>
  );
}

/** A record screen's reader: the procedure the link names (a notice's, a record page's tab). */
export function ProcedureScreen({
  knowledge,
  procedureId,
}: {
  knowledge: ReaderHooks;
  procedureId?: string;
}) {
  if (!procedureId) {
    return <p>Open a procedure from Procedures or To read to read it here.</p>;
  }
  return <ProcedureReader knowledge={knowledge} id={procedureId} />;
}

function SearchResults({
  knowledge,
  q,
  onOpen,
}: {
  knowledge: Pick<ProceduresHooks, "useSearchProcedures">;
  q: string;
  onOpen: (hit: SearchHit) => void;
}) {
  const found = knowledge.useSearchProcedures(q);
  if (found.isPending) return <p aria-busy="true">Searching…</p>;
  if (found.error) {
    return <p role="alert">{knowledgeRefusal(found.error).message}</p>;
  }
  if (!found.data?.items.length) return <p>No published procedure matches "{q}".</p>;
  return (
    <ul className="grid gap-2" aria-label="Search results">
      {found.data.items.map((hit) => (
        <li key={`${hit.id}:${hit.section.anchor ?? ""}`} className="rounded-md border p-3">
          <button
            type="button"
            className="grid gap-1 text-left"
            onClick={() => onOpen(hit)}
            aria-label={`Open ${hit.title ?? "the procedure"}${hit.section.heading ? ` at ${hit.section.heading}` : ""}`}
          >
            <span className="font-medium">
              <Highlight
                segments={
                  hit.titleHighlight.length
                    ? hit.titleHighlight
                    : [{ text: hit.title ?? "Untitled", match: false }]
                }
              />
            </span>
            {hit.section.heading ? (
              <span className="text-sm text-muted-foreground">
                <Highlight segments={hit.section.headingHighlight} />
              </span>
            ) : null}
            {hit.snippet ? (
              <span className="text-sm">
                <Highlight segments={hit.snippet} />
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProcedureList({
  knowledge,
  onOpen,
  locale,
}: {
  knowledge: Pick<ProceduresHooks, "useProcedures" | "useToRead">;
  onOpen: (id: string) => void;
  locale?: string;
}) {
  const list = knowledge.useProcedures({ sort: { field: "title", direction: "asc" }, limit: 100 });
  const mine = knowledge.useToRead();
  if (list.isPending) return <p aria-busy="true">Loading the procedures…</p>;
  if (list.error) return <p role="alert">{knowledgeRefusal(list.error).message}</p>;
  const items = list.data?.items ?? [];
  if (!items.length) return <p>No procedure has been published yet.</p>;
  // Sections only once they are known; an account refused them sees one list.
  const groups = bySection(items);
  const due = new Set((mine.data?.toRead ?? []).map((r) => r.id));
  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <section
          key={group.id ?? "none"}
          aria-label={group.name ?? "Procedures"}
          className="grid gap-2"
        >
          {group.name ? <h2 className="text-lg font-semibold">{group.name}</h2> : null}
          <ul className="grid gap-2">
            {group.items.map((p) => (
              <li key={p.id} className="rounded-md border p-3" data-procedure-item={p.id}>
                <button
                  type="button"
                  className="grid gap-1 text-left"
                  onClick={() => onOpen(p.id)}
                  aria-label={`Open ${titleOf(p)}`}
                >
                  <span className="font-medium">
                    {titleOf(p)}
                    {due.has(p.id) ? (
                      <span className="ml-2 rounded border px-1 text-xs" data-to-read="">
                        To read
                      </span>
                    ) : null}
                  </span>
                  {typeof p.values.summary === "string" && p.values.summary ? (
                    <span className="text-sm">{p.values.summary}</span>
                  ) : null}
                  {p.version !== undefined ? (
                    <span className="text-xs text-muted-foreground">
                      {versionLine(p.version, p.publishedAt, locale)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list.data?.nextCursor ? (
        <p className="text-sm text-muted-foreground">
          Showing the first {items.length}. Search to find the others.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Every published procedure, by section, with a search box; one opens in the reader. Given a
 * `procedureId`, it opens on that one.
 */
export function Procedures({
  knowledge,
  procedureId,
  locale,
  mediaBase,
  mediaUrl,
}: {
  knowledge: ProceduresHooks;
  procedureId?: string;
  locale?: string;
  mediaBase?: string;
  mediaUrl?: MediaUrl;
}) {
  const [open, setOpen] = useState<{ id: string; anchor?: string } | null>(
    procedureId ? { id: procedureId } : null,
  );
  const [q, setQ] = useState("");
  const settled = useSettled(q.trim());
  const searchId = useId();
  if (open) {
    return (
      <ProcedureReader
        knowledge={knowledge}
        id={open.id}
        onBack={() => setOpen(null)}
        {...(open.anchor ? { anchor: open.anchor } : {})}
        {...(locale ? { locale } : {})}
        {...(mediaBase ? { mediaBase } : {})}
        {...(mediaUrl ? { mediaUrl } : {})}
      />
    );
  }
  return (
    <div className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <label htmlFor={searchId} className="text-sm font-medium">
          Search procedures
        </label>
        <Input
          id={searchId}
          type="search"
          value={q}
          maxLength={200}
          autoComplete="off"
          placeholder="Words in a procedure"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {settled ? (
        <SearchResults
          knowledge={knowledge}
          q={settled}
          onOpen={(hit) =>
            setOpen({ id: hit.id, ...(hit.section.anchor ? { anchor: hit.section.anchor } : {}) })
          }
        />
      ) : (
        <ProcedureList
          knowledge={knowledge}
          onOpen={(id) => setOpen({ id })}
          {...(locale ? { locale } : {})}
        />
      )}
    </div>
  );
}
