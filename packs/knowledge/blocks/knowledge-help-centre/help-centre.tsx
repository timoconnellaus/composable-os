// The help centre (stage 38 step 6, ADR 0708), for a business's own website: a search box with
// results as the visitor types, and the help topics with their pages; a topic's own page. Anyone
// reads it, signed in or not: help pages are public in their published wording only (ADR 0442),
// and search is the host's `content.search` over published words (ADR 0700), asked for help
// pages, so it never returns a procedure or a draft. The visitor's words go to the host only as
// the query and are kept nowhere here.
//
// A search box calls the host as the visitor types: the template's operation route passes each
// call with the visitor's address (`forVisitor`), and the host limits public calls per address.
// Allow `x.knowledge.helpTopics`, `content.list` and `content.search` on that route.
import type {
  HelpTopic,
  KnowledgeHooks,
  Published,
  SearchHit,
  Segment,
} from "@composable-os/pack-knowledge/client";
import { slugOf, titleOf } from "@composable-os/pack-knowledge/client";
import { useEffect, useId, useState } from "react";
import { Input } from "../ui-input/input.tsx";

export type HelpCentreHooks = Pick<
  KnowledgeHooks,
  "useHelpTopics" | "useHelpPages" | "useSearchHelp"
>;

/** A value that follows `value` once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Highlight({ segments }: { segments: readonly Segment[] | null | undefined }) {
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

/** Where a search result opens: its page, at its section when the match was under a heading. */
const hitHref = (hit: SearchHit, hrefOf: (slug: string) => string) =>
  `${hrefOf(hit.slug)}${hit.section.anchor ? `#${encodeURIComponent(hit.section.anchor)}` : ""}`;

/** Help pages whose published words match, as the visitor types. */
export function HelpSearch({
  knowledge,
  hrefOf,
  label = "Search help",
}: {
  knowledge: Pick<HelpCentreHooks, "useSearchHelp">;
  /** The page a help page is read on: `(slug) => "/help/" + slug`. */
  hrefOf: (slug: string) => string;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const settled = useSettled(q.trim());
  const found = knowledge.useSearchHelp(settled);
  const id = useId();
  return (
    <search className="grid gap-2" aria-label={label}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="search"
        value={q}
        maxLength={200}
        autoComplete="off"
        placeholder="How do I…"
        onChange={(e) => setQ(e.target.value)}
      />
      {settled ? (
        <div aria-live="polite">
          {found.isPending ? <p aria-busy="true">Searching…</p> : null}
          {found.error ? (
            <p role="alert">We could not search just now. Try again in a moment.</p>
          ) : null}
          {found.data && !found.data.items.length ? (
            <p>Nothing matches "{settled}". Try other words, or browse the topics.</p>
          ) : null}
          {found.data?.items.length ? (
            <ul className="grid gap-2" aria-label="Search results">
              {found.data.items.map((hit) => (
                <li key={`${hit.id}:${hit.section.anchor ?? ""}`} className="grid gap-1">
                  <a href={hitHref(hit, hrefOf)} className="font-medium hover:underline">
                    <Highlight
                      segments={
                        hit.titleHighlight.length
                          ? hit.titleHighlight
                          : [{ text: hit.title ?? "Untitled", match: false }]
                      }
                    />
                  </a>
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
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </search>
  );
}

/** A topic's published pages, in their order. */
export function TopicPages({
  knowledge,
  topicId,
  hrefOf,
}: {
  knowledge: Pick<HelpCentreHooks, "useHelpPages">;
  topicId: string;
  hrefOf: (slug: string) => string;
}) {
  const pages = knowledge.useHelpPages({
    filter: { field: "topic", op: "eq", value: topicId },
    sort: { field: "order", direction: "asc" },
    limit: 100,
  });
  if (pages.isPending) return <p aria-busy="true">Loading…</p>;
  if (pages.error) return <p role="alert">We could not load these pages. Try again soon.</p>;
  const items = (pages.data?.items ?? []).filter((p): p is Published => slugOf(p) !== null);
  if (!items.length) return <p className="text-sm text-muted-foreground">No pages here yet.</p>;
  return (
    <ul className="grid gap-1">
      {items.map((page) => (
        <li key={page.id}>
          <a href={hrefOf(slugOf(page) as string)} className="hover:underline">
            {titleOf(page)}
          </a>
          {typeof page.values.summary === "string" && page.values.summary ? (
            <p className="text-sm text-muted-foreground">{page.values.summary}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The help centre's home: search, then every topic with its pages. */
export function HelpCentre({
  knowledge,
  hrefOf,
  topicHref,
  title = "Help",
}: {
  knowledge: HelpCentreHooks;
  /** The page a help page is read on: `(slug) => "/help/" + slug`. */
  hrefOf: (slug: string) => string;
  /** A topic's own page, when the site has one: `(slug) => "/help/topics/" + slug`. */
  topicHref?: (slug: string) => string;
  title?: string;
}) {
  const topics = knowledge.useHelpTopics();
  const headingId = useId();
  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <h1 id={headingId} className="text-3xl font-semibold">
        {title}
      </h1>
      <HelpSearch knowledge={knowledge} hrefOf={hrefOf} />
      {topics.isPending ? <p aria-busy="true">Loading the topics…</p> : null}
      {topics.error ? (
        <p role="alert">We could not load the help topics. Try again in a moment.</p>
      ) : null}
      {topics.data && !topics.data.topics.length ? <p>There is no help here yet.</p> : null}
      {topics.data?.topics.map((topic: HelpTopic) => (
        <section
          key={topic.id}
          className="grid gap-2"
          aria-label={topic.name ?? "Topic"}
          data-topic={topic.slug ?? topic.id}
          data-icon={topic.icon ?? undefined}
        >
          <h2 className="text-xl font-semibold">
            {topicHref && topic.slug ? (
              <a href={topicHref(topic.slug)} className="hover:underline">
                {topic.name ?? "Untitled topic"}
              </a>
            ) : (
              (topic.name ?? "Untitled topic")
            )}
          </h2>
          <TopicPages knowledge={knowledge} topicId={topic.id} hrefOf={hrefOf} />
        </section>
      ))}
    </div>
  );
}

/** One topic's page, by its address: its name and its pages. */
export function HelpTopicPage({
  knowledge,
  slug,
  hrefOf,
}: {
  knowledge: Pick<HelpCentreHooks, "useHelpTopics" | "useHelpPages">;
  slug: string;
  hrefOf: (slug: string) => string;
}) {
  const topics = knowledge.useHelpTopics();
  if (topics.isPending) return <p aria-busy="true">Loading…</p>;
  const topic = topics.data?.topics.find((t) => t.slug === slug);
  if (topics.error || !topic) return <p role="alert">This topic is not here.</p>;
  return (
    <section className="mx-auto grid max-w-3xl gap-4" aria-label={topic.name ?? "Topic"}>
      <h1 className="text-3xl font-semibold" data-icon={topic.icon ?? undefined}>
        {topic.name ?? "Untitled topic"}
      </h1>
      <TopicPages knowledge={knowledge} topicId={topic.id} hrefOf={hrefOf} />
    </section>
  );
}
