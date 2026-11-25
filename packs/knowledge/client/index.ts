// The Knowledge pack's headless entry (stage 38 step 5; ADRs 0418 and 0453): hooks over the typed
// client, no markup. A client app imports it as `@composable-os/pack-knowledge/client` and hands
// it its generated client; the blocks (step 6) render what it returns.
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

/** A published record as staff or the public read it: its content fields and its slug. */
export interface Published {
  object: string;
  id: string;
  values: Record<string, unknown>;
  version?: number;
  publishedAt?: string;
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
    output: Published & { redirect?: string };
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
      return useQuery<Published & { redirect?: string }>({ ...options, enabled: by !== null });
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
    /** Those who manage: who has read what (one procedure, or every one's counts). */
    useReadStatus(id?: string) {
      return useQuery(api.query("x.knowledge.readStatus", id === undefined ? {} : { id }));
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
