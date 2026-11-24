// Rich text for the web (stage 28, ADR 0440): a post's body drawn block by block with React
// elements, never as HTML. Every block type and mark of the platform's schema has its element
// here; restyle them with the classes, or pass `components` to use the app's own for any of them.
//
// Nothing is injected as markup: text is React text (escaped by React), a link's address is the
// host's checked one, a picture is the host's media route, and a video is played from YouTube's
// or Vimeo's own player address built from the id, never from the raw URL. An embed that is
// neither is a link.
import {
  type Block,
  embedKind,
  embedPlayer,
  headingAnchors,
  type Inline,
  type ListBody,
  mediaPath,
  type RichText as RichTextValue,
} from "@composable-os/pack-content/client";
import type { ReactNode } from "react";
import { Button } from "../ui-button/button.tsx";

/** A block's own element, to replace the default one for its type. */
export type BlockRenderer<T extends Block["type"]> = (props: {
  block: Extract<Block, { type: T }>;
  children?: ReactNode;
  /** A heading's anchor (ADR 0700): give it as the element's `id`, so `#<anchor>` lands on it. */
  anchor?: string;
}) => ReactNode;

export interface RichTextProps {
  value: RichTextValue | null | undefined;
  /**
   * Where a picture is: by default `/api/media/<id>?w=` on this site, which the client template's
   * media route forwards to the host. `mediaBase` puts another origin in front; `mediaUrl`
   * replaces the address altogether.
   */
  mediaUrl?: (id: string, width: number) => string;
  mediaBase?: string;
  /** The app's own element for any block type, in place of the one here. */
  components?: { [T in Block["type"]]?: BlockRenderer<T> };
  className?: string;
}

const WIDTHS = [640, 960, 1280] as const;

/** One run of text with its marks, as nested elements. */
function Run({ run }: { run: Inline }) {
  if (run.type === "break") return <br data-mark="break" />;
  let node: ReactNode = run.text;
  if (run.code) node = <code data-mark="code">{node}</code>;
  if (run.italic) node = <em data-mark="italic">{node}</em>;
  if (run.bold) node = <strong data-mark="bold">{node}</strong>;
  if (run.href) {
    const external = /^https?:/.test(run.href);
    node = (
      <a
        data-mark="link"
        href={run.href}
        className="underline underline-offset-2"
        {...(external ? { rel: "noopener noreferrer" } : {})}
      >
        {node}
      </a>
    );
  }
  return <>{node}</>;
}

function Runs({ content }: { content: readonly Inline[] | undefined }) {
  return (
    <>
      {(content ?? []).map((run, i) => (
        // Runs have no ids; their order is their identity within one block.
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
        <Run key={i} run={run} />
      ))}
    </>
  );
}

function List({ body }: { body: ListBody }) {
  const items = body.items.map((item, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
    <li key={i}>
      <Runs content={item.content} />
      {item.list ? <List body={item.list} /> : null}
    </li>
  ));
  return body.style === "ordered" ? (
    <ol data-block="list" data-style="ordered" className="list-decimal pl-6">
      {items}
    </ol>
  ) : (
    <ul data-block="list" data-style="bullet" className="list-disc pl-6">
      {items}
    </ul>
  );
}

const TONES = {
  info: "border-sky-500",
  note: "border-muted-foreground",
  success: "border-emerald-500",
  warning: "border-amber-500",
} as const;

function DefaultBlock({
  block,
  mediaUrl,
  anchor,
}: {
  block: Block;
  mediaUrl: (id: string, width: number) => string;
  anchor?: string | undefined;
}): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p data-block="paragraph">
          <Runs content={block.content} />
        </p>
      );
    case "heading": {
      // A post's title is its h1: the body's headings start one below it.
      const level = Math.min(Math.max(block.level + 1, 2), 6);
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag id={anchor} data-block="heading" data-level={block.level} className="font-semibold">
          <Runs content={block.content} />
        </Tag>
      );
    }
    case "list":
      return <List body={block} />;
    case "quote":
      return (
        <figure data-block="quote">
          <blockquote className="border-l-4 pl-4 italic">
            <Runs content={block.content} />
          </blockquote>
          {block.attribution ? (
            <figcaption className="text-muted-foreground">{block.attribution}</figcaption>
          ) : null}
        </figure>
      );
    case "image":
      return (
        <figure data-block="image">
          <img
            src={mediaUrl(block.media, 960)}
            srcSet={WIDTHS.map((w) => `${mediaUrl(block.media, w)} ${w}w`).join(", ")}
            sizes="(min-width: 768px) 768px, 100vw"
            alt={block.alt}
            loading="lazy"
            className="w-full rounded-lg"
          />
          {block.caption?.length ? (
            <figcaption className="text-muted-foreground">
              <Runs content={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "divider":
      return <hr data-block="divider" />;
    case "embed": {
      const kind = embedKind(block.url);
      return (
        <figure data-block="embed" data-embed={kind.kind}>
          {kind.kind === "link" ? (
            <a href={block.url} rel="noopener noreferrer" className="underline">
              {block.caption ?? block.url}
            </a>
          ) : (
            <iframe
              src={embedPlayer(kind)}
              title={block.caption ?? (kind.kind === "youtube" ? "YouTube video" : "Vimeo video")}
              allow="encrypted-media; picture-in-picture; fullscreen"
              sandbox="allow-scripts allow-same-origin allow-presentation"
              loading="lazy"
              className="aspect-video w-full rounded-lg"
            />
          )}
          {block.caption && kind.kind !== "link" ? (
            <figcaption className="text-muted-foreground">{block.caption}</figcaption>
          ) : null}
        </figure>
      );
    }
    case "callout":
      return (
        <aside
          data-block="callout"
          data-tone={block.tone}
          role="note"
          className={`rounded-lg border-l-4 bg-muted p-4 ${TONES[block.tone]}`}
        >
          <Runs content={block.content} />
        </aside>
      );
    case "button":
      return (
        <p data-block="button">
          <Button asChild>
            <a href={block.href}>{block.label}</a>
          </Button>
        </p>
      );
  }
}

/** A rich text document. An empty or missing one draws nothing. */
export function RichText({
  value,
  mediaBase = "",
  mediaUrl = (id, width) => mediaPath(id, width, mediaBase),
  components = {},
  className,
}: RichTextProps) {
  const blocks = value?.blocks ?? [];
  if (!blocks.length) return null;
  // Each heading's anchor, made by the host's own rule: search results and citations link to it.
  const anchors = headingAnchors(value);
  let heading = 0;
  return (
    <div className={className ?? "grid gap-4"} data-rich-text="">
      {blocks.map((block, i) => {
        const custom = components[block.type] as BlockRenderer<typeof block.type> | undefined;
        const anchor = block.type === "heading" ? anchors[heading++] : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional in a document.
          <div key={i} className="contents">
            {custom ? (
              custom({ block, ...(anchor ? { anchor } : {}) } as never)
            ) : (
              <DefaultBlock block={block} mediaUrl={mediaUrl} anchor={anchor} />
            )}
          </div>
        );
      })}
    </div>
  );
}
