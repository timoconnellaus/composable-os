# ADR 0440: Rich text is data

Status: accepted, 2026-11-22 (stage 28, build step 1). Builds on ADRs
[0023](0023-extension-contract.md) and [0445](0445-the-document-field.md).

## Context
A post, an event description and an announcement are prose with headings, lists, links and
pictures. The web app and the phone app must each draw them with their own components, so the
host cannot store HTML: a native screen cannot render it, and HTML in a database is where script
gets in. ADR 0445 built the document field for a program's layout and said rich text would be one
fixed schema of it, needing only a way to refuse markup in text.

## Decision

**A field type `richText`** (`{ type: "richText", maxBytes? }`): a document field whose schema is
the platform's one, `RICH_TEXT_SCHEMA` (`packages/sdk/src/rich-text.ts`). A field declares no
`schema`, no `paths` and no `track`; `maxBytes` defaults to 131,072 (at most 524,288). Everything
else is ADR 0445's: the field type's own validation, so every actor, `record.create`,
`record.update`, `record.createMany`, the CSV import, seeds and the approval queue's dry run; the
size checked first; every fault refused with its path; nothing repaired. The SDK's
`documentSchemaOf` gives the schema of either type, and every place the host treated `document`
specially now asks `isDocumentType`.

**The schema.** `{ blocks: [...] }`, at most 1,000 blocks, each one of nine, told apart by `type`:

| Block | Keys |
| --- | --- |
| `paragraph` | `content` (inline runs) |
| `heading` | `level` (1 to 6), `content` |
| `list` | `style` (`bullet`, `ordered`), `items` (1 to 200 of `{ content, list? }`, nesting) |
| `quote` | `content`, `attribution?` |
| `image` | `media` (a ref to a `media` record), `alt`, `caption?` (inline runs) |
| `divider` | nothing |
| `embed` | `url` (a web address; the client decides how to show it), `caption?` |
| `callout` | `tone` (`info`, `note`, `success`, `warning`), `content` |
| `button` | `label`, `href` |

Inline runs (at most 500 a block) are `{ type: "text", text, bold?, italic?, code?, href? }` (1 to
5,000 characters) and `{ type: "break" }`. A key, block type or mark the schema does not name is
refused, as any unknown key of a document is.

**Two text options** in the document schema language (`DocumentTextNode`):
- `noMarkup: true` refuses an HTML tag, closing tag, comment or processing instruction (`<` then a
  letter, `/`, `!` or `?`) and any character reference (`&amp;`, `&#60;`, `&#x3C;`). A `<` before a
  space or a digit, and an ampersand in words, are prose. Every text in the rich text schema has it.
- `href: "web" | "link"` checks a link by its form. `web`: an absolute `http:` or `https:` URL with
  a plain host. `link`: that, `mailto:`, `tel:`, a path on the site (`/events`, never `//host` or
  `/\host`) or an anchor (`#top`). Nothing else: no `javascript:`, `data:`, `vbscript:` or `file:`,
  and no quote, angle bracket, backslash, backtick or space anywhere in it. Runs' `href` and a
  button's are `link`; an embed's `url` is `web`.

ADR 0445 named only `noMarkup`. Links need their own check because a `javascript:` address is
script with no markup in it; it is a text option, not a new mechanism.

**A picture names a media record.** `image.media` is a `ref` to `media`, the base record stage 28's
step 4 adds. Until it exists the ref check refuses any picture (`unknown object media`), so no
document with a picture can be stored yet. That is the seam step 4 fills; the schema does not
change.

**One fixture** (`RICH_TEXT_FIXTURE`, `packages/sdk/src/rich-text-fixture.ts`) has every block type
and every mark. The host's tests store it (without its picture) and both renderers (step 6) must
draw it in full.

**The admin shows its JSON** (the document widget) until the editor (step 5) edits it. The
editor's own format is mapped to this schema at the editor's edge and never stored.

## Proof
`packages/core/test/rich-text.test.ts` (criterion 6):
- The fixture is valid and has every block type and mark. Hostile text (thirteen forms of tags,
  comments and character references) is refused in a run, an alt text, an attribution, a label and
  a caption; thirteen hostile links are refused as both kinds; ordinary links and prose that only
  looks like markup pass.
- For each of the five staff actors (`human`, `assistant`, `mcp`, `automation`, `extension`), an
  HTML string, script in a run, a `javascript:` link, an unknown block, an unknown mark and a
  `data:` embed are refused by `record.create`, `record.update` and `record.createMany`; the CSV
  import refuses one too. The record is unchanged.
- The fuzz test: 5,000 seeded mutations of the fixture (markup in a text, a hostile link, an unknown
  block, an unknown key or `__proto__`, an unknown type, a random value, a list changed, nesting
  past the depth limit, not a document at all). Every hostile one is refused by the check, and
  every value the check passes is clean (valid, no markup, every link of its kind). Then 160
  through the host, rotating the five actors and create, update and createMany: every hostile one
  is refused, and what was stored is exactly what was sent, and clean.

Each check removed, the tests fail (restored after): markup not refused, 4 tests fail; links not
checked, 3; unknown keys and marks let through, 3; unknown block types let through, 3.

## Consequences
- A schema change is a platform change: every product's stored rich text is checked against the
  new one on its next write (ADR 0445), and a block type added must be added to both renderers.
- Tables and code blocks are left out (the interview). The interview's call-to-action button is
  the `button` block; the spec's `callout` is kept beside it.
- An import from HTML (Ghetto's posts, step 7) converts to this schema and lists what does not
  convert; nothing is stored as HTML to convert later.

## Amendment, 2026-11-22 (stage 28, ADR 0444)
The `media` record exists: a rich text picture names a live item of the media library, and the
public is served it while published content shows it. The admin edits rich text with Tiptap,
mapped to this schema at the editor's edge (`apps/app/src/lib/rich-text-map.ts`). Both renderers
are in the Content pack.
