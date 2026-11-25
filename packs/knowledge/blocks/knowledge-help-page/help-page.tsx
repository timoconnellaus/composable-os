// One help page (stage 38 step 6, ADR 0708), for a site's /help/<address> page: its title,
// summary and body as the public reads it (`useHelpPage`: the published version only, ADR 0442),
// and its related pages. An old address answers `redirect`: the page calls `onRedirect` with the
// address it has now, so the site sends a 301 there. A link to a section (`#<anchor>`, from
// search) lands on its heading: the renderer gives each heading the host's anchor as its id.
//
// The body is drawn by the Content pack's renderer only (`content-rich-text`): React elements,
// never HTML, links as the host checked them, pictures from the site's media route, which serves
// only pictures a published page shows.

import { mediaPath, type RichText as RichTextValue } from "@composable-os/pack-content/client";
import type { KnowledgeHooks, Published } from "@composable-os/pack-knowledge/client";
import { helpPageHead, slugOf, titleOf } from "@composable-os/pack-knowledge/client";
import { useId } from "react";
import { RichText } from "../content-rich-text/rich-text.tsx";

export type HelpPageHooks = Pick<KnowledgeHooks, "useHelpPage" | "useHelpPages">;

/** The page's related pages that are published, by their ids. */
function Related({
  knowledge,
  ids,
  hrefOf,
}: {
  knowledge: Pick<HelpPageHooks, "useHelpPages">;
  ids: string[];
  hrefOf: (slug: string) => string;
}) {
  const pages = knowledge.useHelpPages({
    filter: { field: "id", op: "in", value: ids },
    sort: { field: "order", direction: "asc" },
    limit: 20,
  });
  const items = (pages.data?.items ?? []).filter((p) => slugOf(p) !== null);
  if (!items.length) return null;
  return (
    <nav aria-label="Related pages" className="grid gap-2 border-t pt-4">
      <h2 className="text-lg font-semibold">Related</h2>
      <ul className="grid gap-1">
        {items.map((page) => (
          <li key={page.id}>
            <a href={hrefOf(slugOf(page) as string)} className="hover:underline">
              {titleOf(page)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A help page's article: its words, then its related pages. */
export function HelpArticle({
  knowledge,
  page,
  hrefOf,
  mediaBase = "",
  mediaUrl = (id, width) => mediaPath(id, width, mediaBase),
}: {
  knowledge: Pick<HelpPageHooks, "useHelpPages">;
  page: Published;
  hrefOf: (slug: string) => string;
  mediaBase?: string;
  mediaUrl?: (id: string, width: number) => string;
}) {
  const headingId = useId();
  const related = Array.isArray(page.values.related)
    ? page.values.related.filter((id): id is string => typeof id === "string").slice(0, 20)
    : [];
  const summary = typeof page.values.summary === "string" ? page.values.summary : null;
  return (
    <article
      className="mx-auto grid max-w-3xl gap-6"
      aria-labelledby={headingId}
      data-help-page={page.id}
    >
      <header className="grid gap-2">
        <h1 id={headingId} className="text-3xl font-semibold">
          {titleOf(page)}
        </h1>
        {summary ? <p className="text-muted-foreground">{summary}</p> : null}
      </header>
      <RichText value={page.values.body as RichTextValue | null} mediaUrl={mediaUrl} />
      {related.length ? <Related knowledge={knowledge} ids={related} hrefOf={hrefOf} /> : null}
    </article>
  );
}

export function HelpPage({
  knowledge,
  slug,
  hrefOf,
  onRedirect,
  mediaBase,
  mediaUrl,
}: {
  knowledge: HelpPageHooks;
  slug: string;
  /** The page a help page is read on: `(slug) => "/help/" + slug`. */
  hrefOf: (slug: string) => string;
  /** The page's address now, for an old one: send a 301 there. */
  onRedirect: (slug: string) => void;
  mediaBase?: string;
  mediaUrl?: (id: string, width: number) => string;
}) {
  const { data, isPending, error } = knowledge.useHelpPage(slug);
  if (isPending) return <p aria-busy="true">Loading…</p>;
  if (error || !data) {
    return <p role="alert">This help page is not here. It may have moved or been taken down.</p>;
  }
  if (data.kind === "redirect") {
    onRedirect(data.slug);
    return <p>This help page has moved.</p>;
  }
  return (
    <HelpArticle
      knowledge={knowledge}
      page={data}
      hrefOf={hrefOf}
      {...(mediaUrl ? { mediaUrl } : {})}
      {...(mediaBase ? { mediaBase } : {})}
    />
  );
}

/**
 * A help page's head: <title>, the description and `noindex` when the page asks search engines
 * not to list it, as React 19 elements, which React hoists into the document's <head>.
 */
export function HelpPageHead({ page, siteName }: { page: Published; siteName?: string }) {
  const head = helpPageHead(page, siteName ? { siteName } : {});
  return (
    <>
      <title>{head.title}</title>
      {head.description ? <meta name="description" content={head.description} /> : null}
      <meta property="og:title" content={head.title} />
      {head.description ? <meta property="og:description" content={head.description} /> : null}
      {head.robots ? <meta name="robots" content={head.robots} /> : null}
    </>
  );
}
