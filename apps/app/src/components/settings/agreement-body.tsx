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

export function AgreementBody({ value }: { value: unknown }) {
  const blocks = ((value as { blocks?: Block[] } | null)?.blocks ?? []) as Block[];
  return (
    <div className="space-y-2 text-sm" data-testid="agreement-body">
      {blocks.map((block, i) => {
        const key = `${block.type}-${i}`;
        switch (block.type) {
          case "heading":
            return (
              <p key={key} className="font-semibold">
                {runs(block.content)}
              </p>
            );
          case "list":
            return <div key={key}>{list(block)}</div>;
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 pl-3">
                {runs(block.content)}
                {block.attribution ? <footer>{block.attribution}</footer> : null}
              </blockquote>
            );
          case "callout":
            return (
              <div key={key} className="rounded border p-2">
                {runs(block.content)}
              </div>
            );
          case "divider":
            return <hr key={key} />;
          default:
            return <p key={key}>{runs(block.content)}</p>;
        }
      })}
    </div>
  );
}
