// The rich text editor (stage 28, step 5; ADR 0440), for `richText` fields on a record page.
// Built on Tiptap (ProseMirror), chosen at build time: its schema is set to the platform's blocks
// and marks and nothing else, so a paste is parsed into them (a table, a code block or a colour
// keeps its words and loses the rest; a script is never parsed at all). Its own document never
// leaves this file: what is saved is `toRichText` of it, the platform's schema (rich-text-map.ts),
// which the host checks again on save. No HTML is stored, and none is pasted through.
import { isDocumentHref } from "@composable-os/sdk";
import { Button } from "@composable-os/ui/components/button";
import { mergeAttributes, Node } from "@tiptap/core";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  MessageSquareQuoteIcon,
  MinusIcon,
  MousePointerClickIcon,
  StickyNoteIcon,
  VideoIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { fromRichText, type PmNode, richTextProblem, toRichText } from "#/lib/rich-text-map";
import { MediaPicker } from "./media-picker.tsx";

const attr = (name: string, fallback: unknown = null) => ({
  [name]: {
    default: fallback,
    parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? fallback,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: attrs[name] },
  },
});

/** A quote with who said it. */
const Quote = Node.create({
  name: "blockquote",
  group: "block",
  content: "paragraph+",
  defining: true,
  addAttributes: () => ({ ...attr("attribution") }),
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: ({ HTMLAttributes }) => ["blockquote", mergeAttributes(HTMLAttributes), 0],
});

/** A picture from the media library: an atom showing the picture, never an arbitrary image. */
const RichImage = Node.create({
  name: "richImage",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ ...attr("media"), ...attr("alt", ""), ...attr("caption", "") }),
  // Only its own element: a pasted <img> is not a media item, so it is not parsed as one.
  parseHTML: () => [{ tag: "figure[data-rich-image]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "figure",
    mergeAttributes(HTMLAttributes, { "data-rich-image": "", class: "rt-image" }),
    [
      "img",
      {
        src: `/api/media/${encodeURIComponent(String(HTMLAttributes["data-media"] ?? ""))}?w=640`,
        alt: String(HTMLAttributes["data-alt"] ?? ""),
      },
    ],
    ["figcaption", {}, String(HTMLAttributes["data-caption"] ?? "")],
  ],
});

/** A video or a link the client shows as it decides. */
const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  addAttributes: () => ({ ...attr("url", ""), ...attr("caption", "") }),
  parseHTML: () => [{ tag: "div[data-embed]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-embed": "", class: "rt-embed" }),
    `Embed: ${String(HTMLAttributes["data-url"] ?? "")}`,
  ],
});

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  addAttributes: () => ({ ...attr("tone", "note") }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    mergeAttributes(HTMLAttributes, { "data-callout": "", class: "rt-callout" }),
    0,
  ],
});

const CtaButton = Node.create({
  name: "ctaButton",
  group: "block",
  atom: true,
  addAttributes: () => ({ ...attr("label", ""), ...attr("href", "") }),
  parseHTML: () => [{ tag: "div[data-cta]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-cta": "", class: "rt-cta" }),
    `Button: ${String(HTMLAttributes["data-label"] ?? "")} → ${String(HTMLAttributes["data-href"] ?? "")}`,
  ],
});

/** The editor's schema: the platform's blocks and marks, nothing else. */
export const RICH_TEXT_EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    codeBlock: false,
    strike: false,
    underline: false,
    heading: { levels: [2, 3, 4] },
    link: {
      openOnClick: false,
      autolink: true,
      isAllowedUri: (url: string) => isDocumentHref(url, "link"),
    },
  }),
  Quote,
  RichImage,
  Embed,
  Callout,
  CtaButton,
];

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon"
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      onClick={onClick}
    >
      <Icon />
    </Button>
  );
}

function Toolbar({ editor, onPicture }: { editor: Editor; onPicture: () => void }) {
  const chain = () => editor.chain().focus();
  const ask = (question: string, fallback = "") => window.prompt(question, fallback)?.trim() ?? "";
  return (
    <div className="flex flex-wrap gap-1 border-b p-1" role="toolbar" aria-label="Formatting">
      <ToolButton
        icon={BoldIcon}
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => chain().toggleBold().run()}
      />
      <ToolButton
        icon={ItalicIcon}
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => chain().toggleItalic().run()}
      />
      <ToolButton
        icon={CodeIcon}
        label="Code"
        active={editor.isActive("code")}
        onClick={() => chain().toggleCode().run()}
      />
      <ToolButton
        icon={LinkIcon}
        label="Link"
        active={editor.isActive("link")}
        onClick={() => {
          const href = ask(
            "Link to (https://…, /page, mailto:…)",
            String(editor.getAttributes("link").href ?? ""),
          );
          if (!href) chain().unsetLink().run();
          else if (isDocumentHref(href, "link"))
            chain().extendMarkRange("link").setLink({ href }).run();
          else window.alert("That address cannot be a link");
        }}
      />
      <ToolButton
        icon={Heading2Icon}
        label="Heading"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      />
      <ToolButton
        icon={Heading3Icon}
        label="Subheading"
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      />
      <ToolButton
        icon={ListIcon}
        label="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => chain().toggleBulletList().run()}
      />
      <ToolButton
        icon={ListOrderedIcon}
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => chain().toggleOrderedList().run()}
      />
      <ToolButton
        icon={MessageSquareQuoteIcon}
        label="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => chain().toggleWrap("blockquote").run()}
      />
      <ToolButton
        icon={MinusIcon}
        label="Divider"
        onClick={() => chain().setHorizontalRule().run()}
      />
      <ToolButton
        icon={StickyNoteIcon}
        label="Callout"
        onClick={() =>
          chain()
            .insertContent({
              type: "callout",
              attrs: { tone: "note" },
              content: [{ type: "text", text: "Note" }],
            })
            .run()
        }
      />
      <ToolButton icon={ImageIcon} label="Picture" onClick={onPicture} />
      <ToolButton
        icon={VideoIcon}
        label="Embed a video"
        onClick={() => {
          const url = ask("The video's address (YouTube, Vimeo, or any https link)");
          if (url && isDocumentHref(url, "web"))
            chain().insertContent({ type: "embed", attrs: { url } }).run();
          else if (url) window.alert("An embed is an https address");
        }}
      />
      <ToolButton
        icon={MousePointerClickIcon}
        label="Button"
        onClick={() => {
          const label = ask("The button says");
          const href = label ? ask("It goes to (https://…, /page)") : "";
          if (label && href && isDocumentHref(href, "link")) {
            chain().insertContent({ type: "ctaButton", attrs: { label, href } }).run();
          }
        }}
      />
    </div>
  );
}

/**
 * Edits one rich text value. `onChange` gets the platform's rich text (never the editor's own
 * document), and `problem` says what the host would refuse, before saving.
 */
export function RichTextEditor({
  value,
  onChange,
  id,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const initial = useMemo(() => fromRichText(value), [value]);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const editor = useEditor({
    extensions: RICH_TEXT_EXTENSIONS,
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-40 p-3 focus:outline-none",
        ...(id ? { id } : {}),
        "aria-multiline": "true",
        role: "textbox",
        "data-testid": "rich-text-editor",
      },
    },
    onUpdate: ({ editor: e }) => {
      const next = toRichText(e.getJSON() as PmNode);
      setProblem(richTextProblem(next));
      onChange(next.blocks.length ? next : null);
    },
  });
  if (!editor) return <div className="min-h-40 rounded-md border" aria-busy="true" />;
  return (
    <div className="rounded-md border" data-testid="rich-text-field">
      <Toolbar editor={editor} onPicture={() => setPicking(true)} />
      <EditorContent editor={editor} />
      {problem ? (
        <p role="alert" className="border-t p-2 text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(media) => {
          editor
            .chain()
            .focus()
            .insertContent({ type: "richImage", attrs: { media: media.id, alt: media.alt ?? "" } })
            .run();
          setPicking(false);
        }}
      />
    </div>
  );
}
