// An agreement document's body as a person is shown it (stage 44, ADR 0610), read-only: the
// blocks a document may hold (no pictures, embeds or buttons), each run of text with its marks.
// A link is drawn as its own address in full, never as other words (the host refuses link text
// that is not its address), and it is not a link: what a person agrees to is this text alone.
import type { ReactNode } from "react";

type Run = {
  type: string;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
};
type Block = {
  type: string;
  level?: number;
  content?: Run[];
  style?: "bullet" | "ordered";
  items?: { content?: Run[]; list?: Block }[];
  attribution?: string;
  tone?: string;
};

function runs(content: Run[] | undefined): ReactNode {
  return (content ?? []).map((run, i) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity of their own.
    if (run.type === "break") return <br key={i} />;
    let node: ReactNode = run.href ? (
      <span className="break-all underline">{run.href}</span>
    ) : (
      run.text
    );
    if (run.code) node = <code>{node}</code>;
    if (run.italic) node = <em>{node}</em>;
    if (run.bold) node = <strong>{node}</strong>;
    // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity of their own.
    return <span key={i}>{node}</span>;
  });
}

function list(block: Block): ReactNode {
  const Tag = block.style === "ordered" ? "ol" : "ul";
  return (
    <Tag className={block.style === "ordered" ? "list-decimal pl-5" : "list-disc pl-5"}>
      {(block.items ?? []).map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity of their own.
        <li key={i}>
          {runs(item.content)}
          {item.list ? list(item.list) : null}
        </li>
      ))}
    </Tag>
  );
}

const HEADING_SIZES = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-xs"];
const TONES: Record<string, { label: string; className: string }> = {
  info: { label: "Information", className: "border-blue-500 bg-blue-50 dark:bg-blue-950" },
  note: { label: "Note", className: "border-slate-500 bg-slate-50 dark:bg-slate-900" },
  success: { label: "Good to know", className: "border-green-600 bg-green-50 dark:bg-green-950" },
  warning: { label: "Warning", className: "border-amber-500 bg-amber-50 dark:bg-amber-950" },
};

export function AgreementBody({ value }: { value: unknown }) {
  const blocks = ((value as { blocks?: Block[] } | null)?.blocks ?? []) as Block[];
  return (
    <div className="space-y-2 text-sm" data-testid="agreement-body">
      {blocks.map((block, i) => {
        const key = `${block.type}-${i}`;
        switch (block.type) {
          case "heading": {
            // The level is part of what is hashed: drawn as it will appear.
            const level = Math.min(Math.max(block.level ?? 2, 1), 6);
            const Tag = `h${level}` as "h1";
            return (
              <Tag
                key={key}
                data-level={level}
                className={`font-semibold ${HEADING_SIZES[level - 1]}`}
              >
                {runs(block.content)}
              </Tag>
            );
          }
          case "list":
            return <div key={key}>{list(block)}</div>;
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 pl-3">
                {runs(block.content)}
                {block.attribution ? <footer>{block.attribution}</footer> : null}
              </blockquote>
            );
          case "callout": {
            // The tone is hashed too: shown by its colour and named.
            const tone = TONES[block.tone ?? "info"] ?? TONES.info;
            return (
              <div
                key={key}
                className={`rounded border-l-4 p-2 ${tone?.className}`}
                data-tone={block.tone}
              >
                <span className="mr-1 font-medium">{tone?.label}:</span>
                {runs(block.content)}
              </div>
            );
          }
          case "divider":
            return <hr key={key} />;
          default:
            return <p key={key}>{runs(block.content)}</p>;
        }
      })}
    </div>
  );
}
