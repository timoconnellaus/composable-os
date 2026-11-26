// The Knowledge pack's headless entry (stage 38 steps 5 and 6; ADRs 0418, 0453 and 0708): hooks
// over the typed client and plain functions, no markup. A client app imports it as
// `@composable-os/pack-knowledge/client` and hands it its generated client; the blocks
// (`packs/knowledge/blocks`, web and native) render what it returns, and the admin's declared
// screens get the same hooks over the staff client.
//
// Staff read procedures as published with the host's `content.staffGet`, `content.staffList` and
// `content.search` (ADR 0701), never the working copy, and confirm with this pack's `confirm`
// tool. The public reads help pages as published with `content.get`, `content.list` and
// `content.search` (ADRs 0442, 0700). Nothing here decides who may read what, what is to read,
// or whether a confirmation counts: those are the host's.
import {
  type ClientHolding,
  type PackClient,
  packHooks,
  type UseMutation,
  type UseQuery,
} from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type { confirm, helpTopics, readStatus, toRead } from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The objects, as the host names them. */
export const PROCEDURE = "knowledge.procedure";
export const HELP_PAGE = "knowledge.helppage";
export const SECTION = "knowledge.section";

/** A published record as staff or the public read it: its content fields and its slug. */
export interface Published {
  object: string;
  id: string;
  values: Record<string, unknown>;
  version?: number;
  publishedAt?: string;
  /**
   * Staff read: the title of each related record the object names in `staffNames` (a procedure's
   * section's name), by field, from the host (ADR 0708).
   */
  names?: Record<string, string>;
}

/** A part of a highlighted title, heading or snippet: plain, or a matching word. */
export interface Segment {
  text: string;
  match: boolean;
}

export interface SearchHit {
  object: string;
  id: string;
  slug: string;
  title: string | null;
  titleHighlight: Segment[];
  version: number;
  section: { field: string; anchor: string | null; heading: string; headingHighlight: Segment[] };
  snippet: Segment[] | null;
}

type Page<T> = { items: T[]; nextCursor: string | null };
type ListInput = {
  object: string;
  filter?: unknown;
  sort?: { field: string; direction: "asc" | "desc" };
  cursor?: string;
  limit?: number;
};

/** The operations this entry calls, as the generated client types them. */
export type KnowledgeOperations = {
  // Staff: procedures as published (every staff account, pack roles included).
  "content.staffGet": {
    kind: "query";
    input: { object: string; id?: string; slug?: string };
    output: Published & { redirect?: string; pictures?: boolean };
  };
  "content.staffList": { kind: "query"; input: ListInput; output: Page<Published> };
  "x.knowledge.toRead": { kind: "query" } & Io<typeof toRead>;
  "x.knowledge.confirm": { kind: "mutation" } & Io<typeof confirm>;
  "x.knowledge.readStatus": { kind: "query" } & Io<typeof readStatus>;
  // Anyone: help pages as published, and their topics.
  "content.get": {
    kind: "query";
    input: { object: string; slug: string };
    output: (Published & { kind: "record" }) | { kind: "redirect"; object: string; slug: string };
  };
  "content.list": { kind: "query"; input: ListInput; output: Page<Published> };
  "content.search": {
    kind: "query";
    input: { object: string; q: string; cursor?: string; limit?: number };
    output: Page<SearchHit>;
  };
  "x.knowledge.helpTopics": { kind: "query" } & Io<typeof helpTopics>;
};

type Name = keyof KnowledgeOperations & string;
type In<N extends Name> = KnowledgeOperations[N]["input"];

/** The client of every operation this entry calls (ADR 0453). */
export type KnowledgeClient = PackClient<KnowledgeOperations>;

export type { UseMutation, UseQuery } from "@composable-os/client";

/**
 * The operations each hook calls (ADR 0453). The staff client (a pack-role account's too) gets
 * the procedure hooks; a customer's client and the public's get the help centre's.
 */
export const KNOWLEDGE_HOOKS_CALL = {
  useProcedures: ["content.staffList"],
  useProcedure: ["content.staffGet"],
  useSearchProcedures: ["content.search"],
  useToRead: ["x.knowledge.toRead"],
  useConfirm: ["x.knowledge.confirm"],
  useReadStatus: ["x.knowledge.readStatus"],
  useHelpTopics: ["x.knowledge.helpTopics"],
  useHelpPages: ["content.list"],
  useHelpPage: ["content.get"],
  useSearchHelp: ["content.search"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const knowledge = createKnowledgeHooks({ useQuery, useMutation }, api)`. The hooks a client
 * cannot back are not there, and calling one does not compile.
 */
export function createKnowledgeHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, KNOWLEDGE_HOOKS_CALL, (api: KnowledgeClient) =>
    allKnowledgeHooks(react, api),
  );
}

const idle = (name: string) => ({
  queryKey: [name, "none"],
  queryFn: async () => undefined as never,
});

function allKnowledgeHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: KnowledgeClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** Staff: a page of published procedures (by section, or as asked). */
    useProcedures(input: Omit<In<"content.staffList">, "object"> = {}) {
      return useQuery(api.query("content.staffList", { object: PROCEDURE, ...input }));
    },
    /** Staff: one procedure as published, by id or address. */
    useProcedure(by: { id: string } | { slug: string } | null) {
      const options = by
        ? api.query("content.staffGet", { object: PROCEDURE, ...by })
        : idle("content.staffGet");
      return useQuery<Published & { redirect?: string; pictures?: boolean }>({
        ...options,
        enabled: by !== null,
      });
    },
    /** Staff: procedures whose published words match, each with its section's anchor. */
    useSearchProcedures(q: string) {
      const options = q.trim()
        ? api.query("content.search", { object: PROCEDURE, q })
        : idle("content.search");
      return useQuery<Page<SearchHit>>({ ...options, enabled: q.trim() !== "" });
    },
    /** Staff: what I must read, and what I confirmed. */
    useToRead() {
      return useQuery(api.query("x.knowledge.toRead", {}));
    },
    /** Staff: "I have read and understood this", for the version read. */
    useConfirm() {
      return useMutation(api.mutation("x.knowledge.confirm"));
    },
    /**
     * Those who manage: who has read what (one procedure, or every one's counts). Kept in the
     * cache no longer than it is on screen (`gcTime: 0`): who has not read what is not left
     * behind when the screen closes.
     */
    useReadStatus(id?: string) {
      return useQuery({
        ...api.query("x.knowledge.readStatus", id === undefined ? {} : { id }),
        gcTime: 0,
      });
    },
    /** Anyone: the help topics, in their order. */
    useHelpTopics() {
      return useQuery(api.query("x.knowledge.helpTopics", {}));
    },
    /** Anyone: a page of published help pages (a topic's, or as asked). */
    useHelpPages(input: Omit<In<"content.list">, "object"> = {}) {
      return useQuery(api.query("content.list", { object: HELP_PAGE, ...input }));
    },
    /** Anyone: one published help page by its address; an old address answers `redirect`. */
    useHelpPage(slug: string | null) {
      const options = slug
        ? api.query("content.get", { object: HELP_PAGE, slug })
        : idle("content.get");
      return useQuery<KnowledgeOperations["content.get"]["output"]>({
        ...options,
        enabled: slug !== null,
      });
    },
    /** Anyone: help pages whose published words match, as the reader types. */
    useSearchHelp(q: string) {
      const options = q.trim()
        ? api.query("content.search", { object: HELP_PAGE, q })
        : idle("content.search");
      return useQuery<Page<SearchHit>>({ ...options, enabled: q.trim() !== "" });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<KnowledgeHooks, "useToRead">`. */
export type KnowledgeHooks = ReturnType<typeof allKnowledgeHooks>;

// --- Plain functions (display only: every answer is the host's) ----------------------------------

/** My list, as `useToRead` answers it. */
export type ToReadAnswer = KnowledgeOperations["x.knowledge.toRead"]["output"];
/** Read status, as `useReadStatus` answers it. */
export type ReadStatusAnswer = KnowledgeOperations["x.knowledge.readStatus"]["output"];
/** One procedure's read status: who must read it, who has confirmed and who has not. */
export type ProcedureStatus = NonNullable<ReadStatusAnswer["procedure"]>;
/** A help topic, as `useHelpTopics` answers it. */
export type HelpTopic = KnowledgeOperations["x.knowledge.helpTopics"]["output"]["topics"][number];

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** A published record's title (its `title` field), or the words for one with none. */
export function titleOf(record: Pick<Published, "values">): string {
  return str(record.values.title) ?? "Untitled";
}

/** A published record's address (its `slug`), or null. */
export function slugOf(record: Pick<Published, "values">): string | null {
  return str(record.values.slug);
}

/**
 * Where a help page is read on the business's site by default: `/help/<address>` (the help page's
 * address field says so). A site with another layout passes its own `hrefOf` to the blocks.
 */
export function helpHref(slug: string): string {
  return `/help/${encodeURIComponent(slug)}`;
}

/** A date as words in the locale: "3 March 2026". Empty for what is not a date. */
export function dayWords(iso: string, locale = "en-AU"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** "Version 4, published 3 March 2026": which wording this is, as the host numbered it. */
export function versionLine(version: number, publishedAt?: string, locale?: string): string {
  const day = publishedAt ? dayWords(publishedAt, locale) : "";
  return day ? `Version ${version}, published ${day}` : `Version ${version}`;
}

/**
 * The confirm button's words: what is being confirmed, by name and version, so the tap says which
 * wording the person read: `I have read and understood "Injuries" (version 4)`.
 */
export function confirmLabel(title: string, version: number): string {
  return `I have read and understood "${title}" (version ${version})`;
}

/**
 * Where the procedure on screen stands for me, from my list (`useToRead`) and the version shown
 * (`useProcedure`): `to_read` (I am asked, and this is the version to confirm), `newer` (I am
 * asked, but a newer version was published since this one was opened: read that one), `confirmed`
 * (I have a confirmation that counts for the current version, `version`, made at `confirmedAt`:
 * of this version, or of an earlier one that later small fixes kept) or `not_asked`. Display only: the host refuses a confirmation of
 * a version that is not current or not mine to confirm, whatever this says.
 */
export type MyStanding =
  | { kind: "to_read"; since: string }
  | { kind: "newer"; version: number }
  | { kind: "confirmed"; version: number; confirmedAt: string }
  | { kind: "not_asked" };

export function myStanding(
  mine: ToReadAnswer | undefined,
  id: string,
  shownVersion: number,
): MyStanding {
  const due = mine?.toRead.find((r) => r.id === id);
  if (due) {
    return due.version > shownVersion
      ? { kind: "newer", version: due.version }
      : { kind: "to_read", since: due.since };
  }
  const done = mine?.confirmed.find((r) => r.id === id);
  if (done) return { kind: "confirmed", version: done.version, confirmedAt: done.confirmedAt };
  return { kind: "not_asked" };
}

/** Procedures under one section (or none). */
export interface SectionGroup {
  name: string | null;
  items: Published[];
}

/** A published procedure's section's name, as the host gave it (`names.section`), or null. */
export function sectionOf(record: Pick<Published, "names">): string | null {
  return str(record.names?.section);
}

/**
 * A page of procedures grouped by their section's name (the host's `names`, ADR 0708), the
 * sections in alphabetical order, those with none last ("Other" when there are sections).
 */
export function bySection(procedures: readonly Published[], locale = "en-AU"): SectionGroup[] {
  const groups = new Map<string, Published[]>();
  const other: Published[] = [];
  for (const procedure of procedures) {
    const name = sectionOf(procedure);
    if (name === null) other.push(procedure);
    else groups.set(name, [...(groups.get(name) ?? []), procedure]);
  }
  const named: SectionGroup[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, locale))
    .map(([name, items]) => ({ name, items }));
  if (other.length) named.push({ name: named.length ? "Other" : null, items: other });
  return named;
}

/** A highlighted line's words, joined (for a label). */
export function segmentsText(segments: readonly Segment[] | null | undefined): string {
  return (segments ?? []).map((s) => s.text).join("");
}

/** What a refusal from the host means for the reader, with the words to show. */
export type KnowledgeRefusalKind =
  | "not_current"
  | "already_confirmed"
  | "not_found"
  | "forbidden"
  | "network"
  | "other";

export interface KnowledgeRefusal {
  kind: KnowledgeRefusalKind;
  message: string;
  /** For `not_current`: the version that is current now. */
  current?: number;
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/**
 * A refusal as the blocks show it. The confirm tool passes on the host's own refusal: its code and
 * reason (`not_current` with the current version, `already_confirmed`) are in the error's
 * details, or one level in when a tool wrapped them.
 */
export function knowledgeRefusal(error: unknown): KnowledgeRefusal {
  const e = obj(error);
  if (e?.name === "NetworkError") {
    return {
      kind: "network",
      message: "You are offline, or the host could not be reached. Try again.",
    };
  }
  const outer = obj(e?.details);
  const inner = obj(outer?.details);
  const reason = [inner?.reason, outer?.reason].find((r) => typeof r === "string");
  if (reason === "not_current") {
    const current = [inner?.current, outer?.current].find((c) => typeof c === "number");
    return {
      kind: "not_current",
      message:
        "A newer version has been published since you opened this one. Read the new version and confirm that.",
      ...(typeof current === "number" ? { current } : {}),
    };
  }
  if (reason === "already_confirmed") {
    return { kind: "already_confirmed", message: "You have already confirmed this version." };
  }
  const code = [outer?.code, e?.code].find((c) => typeof c === "string");
  // The admin's staff client keeps a tool's inner details only (`{ object, id }` for not found).
  const notFound =
    code === "not_found" ||
    (e?.code === "extension_error" &&
      typeof outer?.object === "string" &&
      typeof outer?.id === "string");
  if (notFound) {
    return {
      kind: "not_found",
      message: "This is not here: it may have been unpublished, or it is not yours to confirm.",
    };
  }
  if (code === "forbidden") {
    return {
      kind: "forbidden",
      message: "Your account cannot see this. Ask an admin if you think it should.",
    };
  }
  const message = typeof e?.message === "string" && e.message ? e.message : null;
  return { kind: "other", message: message ?? "Something went wrong. Try again." };
}

/** A CSV cell: quoted, quotes doubled, and a leading formula sign made plain text. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * One procedure's read status as CSV (the Read status screen's export), made from the host's
 * answer on screen when the person asks: name, email, whether they confirmed this version and
 * when, the last version they confirmed, and since when it has been to read.
 */
export function readStatusCsv(status: ProcedureStatus): string {
  const rows = [
    [
      "Name",
      "Email",
      "Confirmed this version",
      "Confirmed at",
      "Last version confirmed",
      "To read since",
    ],
    ...status.people.map((p) => [
      p.name,
      p.email,
      p.confirmed ? "yes" : "no",
      p.confirmed?.confirmedAt ?? "",
      p.lastConfirmed ? String(p.lastConfirmed.version) : "",
      p.confirmed ? "" : (p.since ?? ""),
    ]),
  ];
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** A help page's head: its title, description and whether search engines may list it. */
export function helpPageHead(
  page: Pick<Published, "values">,
  options: { siteName?: string } = {},
): { title: string; description: string | null; robots: string | null } {
  const v = page.values;
  const own = str(v.seoTitle);
  const title = own ?? titleOf(page);
  return {
    title: options.siteName && !own ? `${title} · ${options.siteName}` : title,
    description: str(v.seoDescription) ?? str(v.summary),
    robots: v.noindex === true ? "noindex" : null,
  };
}
