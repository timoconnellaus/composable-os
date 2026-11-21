// The Content pack's headless entry (stage 28, step 6; ADRs 0418 and 0453): functions and hooks
// over the typed client, no markup. A client app imports it as `@composable-os/pack-content/client`
// and hands it its generated client; the content blocks render what it returns.
//
// The public reads posts with the host's own `content.get`, `content.list` and `content.preview`
// (ADR 0442): only published versions, only the fields the post declares public. Nothing here
// decides what is published or who may read it. Rich text arrives as structured data (ADR 0440);
// the renderers draw it block by block with the app's own components and never as HTML.
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type { categories } from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The post object, as the host names it. */
export const POST = "content.post";

// --- Rich text, as the host stores and serves it (RICH_TEXT_SCHEMA, ADR 0440) -----------------

export interface TextRun {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}
export interface LineBreak {
  type: "break";
}
export type Inline = TextRun | LineBreak;
export interface ListItem {
  content: Inline[];
  list?: ListBody;
}
export interface ListBody {
  style: "bullet" | "ordered";
  items: ListItem[];
}
export type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "heading"; level: number; content: Inline[] }
  | ({ type: "list" } & ListBody)
  | { type: "quote"; content: Inline[]; attribution?: string }
  | { type: "image"; media: string; alt: string; caption?: Inline[] }
  | { type: "divider" }
  | { type: "embed"; url: string; caption?: string }
  | { type: "callout"; tone: "info" | "note" | "success" | "warning"; content: Inline[] }
  | { type: "button"; label: string; href: string };
export interface RichText {
  blocks: Block[];
}

/** A picture field's value (ADR 0444). */
export interface Picture {
  media: string;
  alt: string;
  focal?: { x: number; y: number };
}

/** A published post as the public reads it: only the fields the post declares public. */
export interface PublicPost {
  object: string;
  id: string;
  values: {
    title?: string | null;
    slug?: string | null;
    excerpt?: string | null;
    body?: RichText | null;
    cover?: Picture | null;
    category?: string | null;
    date?: string | null;
    publishedAt?: string | null;
  };
}

export type PostAnswer =
  | (PublicPost & { kind: "record" })
  | { kind: "redirect"; object: string; slug: string };

/** The operations this entry calls, as the generated client types them. */
export type ContentOperations = {
  "content.get": {
    kind: "query";
    input: { object: string; slug: string };
    output: PostAnswer;
  };
  "content.list": {
    kind: "query";
    input: {
      object: string;
      filter?: unknown;
      sort?: { field: string; direction: "asc" | "desc" };
      cursor?: string;
      limit?: number;
    };
    output: { items: PublicPost[]; nextCursor: string | null };
  };
  "content.preview": {
    kind: "query";
    input: { object: string; slug: string; token: string };
    output: PublicPost & { kind: "preview" };
  };
  "x.content.categories": { kind: "query" } & Io<typeof categories>;
  // Staff: the publish controls (ADRs 0446, 0441). A person publishes; the assistant drafts.
  "record.publish": {
    kind: "mutation";
    input: { object: string; id: string; note?: string };
    output: { version: number; publishedAt: string };
  };
  "record.schedulePublish": {
    kind: "mutation";
    input: { object: string; id: string; at: string; note?: string };
    output: { publishAt: string };
  };
  "record.unpublish": {
    kind: "mutation";
    input: { object: string; id: string };
    output: { unpublished: number };
  };
};

type Name = keyof ContentOperations & string;
type In<N extends Name> = ContentOperations[N]["input"];

/** The client of every operation this entry calls (ADR 0453). */
export type ContentClient = PackClient<ContentOperations>;

// --- Plain functions ------------------------------------------------------------------------------

/**
 * Where a picture is, at the width asked for: `/api/media/<id>?w=640` on a site's own hostname,
 * which the client template's media route forwards to the host (issue #181). `base` puts another
 * origin or prefix in front (`https://cdn.example.com`).
 */
export function mediaPath(id: string, width?: number, base = ""): string {
  return `${base.replace(/\/+$/, "")}/api/media/${encodeURIComponent(id)}${width ? `?w=${Math.round(width)}` : ""}`;
}

/**
 * Where a phone asks the host itself for a picture: its public media route beside the HTTP
 * surface, `https://<host>/api/v1/media/<id>?w=<width>` (bypassed by Cloudflare Access with the
 * rest of /api/v1). For the native blocks' `mediaUrl`: `hostMediaUrl(hostUrl)`.
 */
export function hostMediaUrl(hostUrl: string): (id: string, width: number) => string {
  const host = hostUrl.replace(/\/+$/, "");
  return (id, width) =>
    `${host}/api/v1/media/${encodeURIComponent(id)}${width ? `?w=${Math.round(width)}` : ""}`;
}

/** The text of inline runs, without marks: for excerpts, alt text and screen readers. */
export function inlineText(content: readonly Inline[] | undefined): string {
  return (content ?? []).map((run) => (run.type === "text" ? run.text : "\n")).join("");
}

/** A document's words, block by block, for a summary or a search box. */
export function plainText(value: RichText | null | undefined): string {
  const out: string[] = [];
  const list = (body: ListBody) => {
    for (const item of body.items) {
      out.push(inlineText(item.content));
      if (item.list) list(item.list);
    }
  };
  for (const block of value?.blocks ?? []) {
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "quote":
      case "callout":
        out.push(inlineText(block.content));
        break;
      case "list":
        list(block);
        break;
      case "image":
        if (block.caption) out.push(inlineText(block.caption));
        break;
      case "embed":
        if (block.caption) out.push(block.caption);
        break;
      case "button":
        out.push(block.label);
        break;
      case "divider":
        break;
    }
  }
  return out.filter(Boolean).join("\n");
}

/** What an embed's address is: a YouTube or Vimeo video the renderer can show, or a link. */
export function embedKind(
  url: string,
): { kind: "youtube"; id: string } | { kind: "vimeo"; id: string } | { kind: "link" } {
  const youtube =
    /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{6,20})/.exec(url) ??
    /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{6,20})/.exec(url) ??
    /^https:\/\/(?:www\.)?youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,20})/.exec(url);
  if (youtube?.[1]) return { kind: "youtube", id: youtube[1] };
  const vimeo = /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?([0-9]{4,15})/.exec(url);
  if (vimeo?.[1]) return { kind: "vimeo", id: vimeo[1] };
  return { kind: "link" };
}

/** The player address for a video embed, from the id `embedKind` found (never the raw URL). */
export function embedPlayer(kind: { kind: "youtube" | "vimeo"; id: string }): string {
  return kind.kind === "youtube"
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(kind.id)}`
    : `https://player.vimeo.com/video/${encodeURIComponent(kind.id)}`;
}

/** A post's date as a reader sees it (`21 Nov 2026`), in their own locale. Display only. */
export function postDate(post: PublicPost, locale?: string): string {
  const iso = post.values.date ?? post.values.publishedAt;
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  } catch {
    return iso.slice(0, 10);
  }
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/**
 * The operations each hook calls (ADR 0453). A customer's client and the public's get the
 * reading hooks; the staff client gets the publish controls too.
 *
 * Criterion 12 (an AI actor's publish queued for a person) is undecided: `usePublish` calls
 * `record.publish`, which is a person's only. Whatever is decided changes this map and that one
 * hook, not the blocks.
 */
export const CONTENT_HOOKS_CALL = {
  usePosts: ["content.list"],
  usePost: ["content.get"],
  usePreview: ["content.preview"],
  useCategories: ["x.content.categories"],
  usePublish: ["record.publish"],
  useSchedulePublish: ["record.schedulePublish"],
  useUnpublish: ["record.unpublish"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const content = createContentHooks({ useQuery, useMutation }, api)`. `api` is any generated
 * client: the customer's, the public's (the same customer client, signed out) or the staff one.
 * The hooks it cannot back are not there, and calling one does not compile.
 */
export function createContentHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, CONTENT_HOOKS_CALL, (api: ContentClient) => allContentHooks(react, api));
}

function allContentHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: ContentClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** A page of published posts, newest first (or as asked). */
    usePosts(input: Omit<In<"content.list">, "object"> = {}, object: string = POST) {
      return useQuery(api.query("content.list", { object, ...input }));
    },
    /**
     * One published post by its address. An old address answers `redirect`: send the reader to
     * the post's address now (a 301 on the web).
     */
    usePost(slug: string | null, object: string = POST) {
      const options = slug
        ? api.query("content.get", { object, slug })
        : { queryKey: ["content.get", "none"], queryFn: async () => undefined as never };
      return useQuery<PostAnswer>({ ...options, enabled: slug !== null });
    },
    /** A post's working copy, with a preview link's token. */
    usePreview(slug: string | null, token: string | null, object: string = POST) {
      const options =
        slug && token
          ? api.query("content.preview", { object, slug, token })
          : { queryKey: ["content.preview", "none"], queryFn: async () => undefined as never };
      return useQuery<PublicPost & { kind: "preview" }>({
        ...options,
        enabled: Boolean(slug && token),
      });
    },
    /** The categories, by name. */
    useCategories() {
      return useQuery(api.query("x.content.categories", {}));
    },
    /** Staff: publish a post now (a person with the publish permission). */
    usePublish() {
      return useMutation(api.mutation("record.publish"));
    },
    /** Staff: publish a post at a time; what is published is the post as it is now. */
    useSchedulePublish() {
      return useMutation(api.mutation("record.schedulePublish"));
    },
    /** Staff: take a post down; its versions are kept. */
    useUnpublish() {
      return useMutation(api.mutation("record.unpublish"));
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<ContentHooks, "usePost">`. */
export type ContentHooks = ReturnType<typeof allContentHooks>;
