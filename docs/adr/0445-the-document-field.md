# ADR 0445: The document field

Status: accepted, 2026-11-21 (stage 41, build step 1). Builds on ADRs
[0023](0023-extension-contract.md) and [0404](0404-behaviours-are-the-vocabulary.md).

## Context
A program's layout is weeks of sessions of blocks of items, each item bank exercises with typed
sets or up to five levels. Stored as records per level it would be five tables and hundreds of
rows per program, and a program could not be edited, versioned or copied whole. The stage 41
interview decided it is one document. The field types (ADR 0023) had nothing for it: `longText`
holds a string the host does not understand, so nothing would stop an import, an MCP client or a
pack's tool writing a layout no builder can read. Stage 28's `richText` needs the same thing with a
fixed schema.

## Decision

**A field type `document`:** one JSON value, checked against a schema the field declares, on
every write by every actor.

```ts
layout: {
  type: "document",
  label: "Layout",
  schema: LAYOUT_SCHEMA,          // { root: <object node>, defs?: { <name>: <node> } }
  maxBytes: 524_288,              // default 65,536; at most 524,288
  paths: { weekCount: { label: "Weeks", path: "weeks", count: true } },
}
```

**The schema is plain data** (`DocumentSchema`, `packages/sdk/src/document.ts`), so the manifest
carries it and the host, `cos ext check` and the SDK's test host read one declaration. Nine kinds
of node: `object` (named fields, `optional` per field, every other key refused), `array` (`max`
required, `min`, `unique` on a key of its entries), `text` (`max`, default 1,000, at most 20,000;
`min`; `multiline`; `chars`, the only characters allowed), `number` (`min`, `max`, `integer`,
`step`), `boolean`, `choice` (a fixed list of words), `ref` (the id of a record of a named object),
`union` (objects told apart by a `tag` key) and `use` (a named definition, for nesting). There is
no free pattern, so no expression in a manifest can make the host's check slow.

**Validation never repairs a value.** A fault is refused with its path from the document's root:
`Invalid value for programs.program.layout: layout.weeks.1.sessions.0.blocks.0.items.0.levels.1.level:
1 is there twice (also entry 0)`, with every fault (up to 20) in `details.issues`, each with its
`path`. The size is checked first, in bytes of the JSON (`documentBytes`), before the value is
walked; nesting is capped at 24. The check is the field type's zod schema in the host's field-type
registry, so it runs wherever a value is validated: `record.create`, `record.update`,
`record.createMany`, the record CSV import, seeds, the host's own writes and the approval queue's
dry run (which runs the same handler with its writes discarded).

**Refs are checked like relations.** After the shape, each object a document's `ref`s name is
read once, through the caller's seam, and an id that is not a live record of it is refused with
the ref's path: `layout.weeks.0.sessions.1.blocks.0.items.0.exercises.0.exercise: no live
programs.exercise with id …`.

**Declared paths are columns.** A path is keys through objects from the root (`title`,
`meta.level`), reaching a text, choice, number, boolean or ref, or a list with `count: true`. Each
is a read-only column of the object's `rec_*` view (`json_extract` or `json_array_length` of the
stored column, the path checked by `documentJsonPath`) and a read-only registry field, so lists
filter and sort by it, `query.sql` and dashboards read it, and nobody writes it. The document
itself is neither filtered nor sorted.

**Private parts are the seam's.** An object node may declare `private: true`, or
`private: { unless: "<boolean key>" }`. When a customer or the public reads a record, the seam
(`visibility/records.ts`) returns the document with every private object removed (a list's entry,
or an object's key) unless its `unless` key is true. A value that does not fit its schema is
returned to them as null: an outsider is never shown what was not checked. Staff read the whole
document. A coach's note in a program is for coaches unless marked as shown to members.

**Not on the timeline, no default, no formula.** A document field cannot be tracked, takes no
default, and formulas do not read it. Its storage is `TEXT`; no type change to or from it is
lossless. The admin shows it as its JSON; a pack's block edits it.

## Stage 28's `richText`
`richText` is a document with one fixed schema the platform owns: blocks as a `union` on `type`
(paragraph, heading, list, quote, image, divider, embed, callout), inline runs as a `union` of text
with marks, lists nesting through `use`. Stage 28 adds the type name, the schema and its fuzz test;
the validation, the size limit, the path of a fault and the import and dry-run coverage are this
ADR's and need no change. The one thing a fixed schema needs that this does not have is refusing
HTML in text, which is a `text` node option stage 28 adds (`noMarkup`), not a new mechanism.

## Why
- A rule on what a layout may hold is a behaviour of the field, so it holds for the UI, MCP, an
  import, a pack's tool and the assistant alike, and the approval queue can simulate it.
- A small schema language of our own, rather than JSON Schema, because the host must be able to
  check any declared schema cheaply and report a fault a person can act on, and because every
  kind of node is one a builder can draw. Patterns, references to other schemas and conditional
  keywords are what make JSON Schema validators slow or surprising.
- Paths as columns keep the document whole while letting the data it holds be listed and charted.

## Consequences
- A schema change does not rewrite stored documents. A document written under an older schema is
  checked against the new one on its next write; a tightened schema can refuse an edit of an
  existing record until it is fixed. The check reports which path.
- Reading a ref's records is one read per object named, per write of the field.
- The SDK is type-checked without a runtime library, so `documentBytes` counts UTF-8 by hand.
