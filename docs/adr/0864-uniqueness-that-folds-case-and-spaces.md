# ADR 0864: Uniqueness that folds case and spaces

Status: accepted, 2026-11-26 (stage 59, build step 3, the review of PR #491). Block BU. Extends
[ADR 0502](0502-declared-uniqueness.md) (declared uniqueness); no migration.

## Context
Equipment's tag is the code on an item's sticker, and a register is often loaded from a
spreadsheet (stage 59, acceptance criterion 15: "the tag matches an item that exists, so a second
run creates nothing twice"). ADR 0502's rule compares the stored values exactly, and a text field
is stored as written. The review of PR #491 showed `cs-x` and `CS-x ` accepted beside `CS-x`, by a
form and by an import: a spreadsheet re-exported with other case or a stray space made the items
again. Comparing case-insensitively in a pack's tool would be a rule in a tool (ADR 0405), and
would not hold for the record page or the import.

## Decision
- **A uniqueness rule may declare `fold: true`.** Every field it names is then a `text` field (the
  contract refuses any other), and the host keeps those fields **folded** on every create and
  update, whoever writes and by whatever path (a form, the assistant, MCP, the admin's import,
  `record.createMany`): Unicode NFKC, white space trimmed from both ends, letters in upper case
  (`foldUniqueText` in the SDK). A value that is only white space is no value. So `tm-03 `,
  `Tm-03` and `TM-03` are one value, stored as `TM-03`, and the rule's partial unique index (ADR
  0502) refuses the second with no change to how it is built.
- **Stored folded, not compared folded.** Keeping the folded text is what promo code words already
  do (ADR 0940): the index, the read before the write, a list's filter and a search all see one
  spelling, and nothing reads around it. The cost is that the value is shown in upper case, which
  suits codes and tags, the use it is for. A rule over names or addresses should not fold.
- **Inner spaces are kept** (`TM 03` is not `TM03`): a code with a space in it is written so on
  purpose more often than by mistake, and folding them away could merge two real tags.
- A rule that starts folding on an object that has records leaves those records as they are until
  each is next written; the reconciler's check for live records that already break a rule compares
  stored values, as before.

## Consequences
- Equipment's item declares `unique: [{ fields: ["tag"], states: ["in_service", "out_of_service"],
  fold: true }]` (ADR 0862).
- A restore whose declared unique values were taken while the record was in the Trash is refused
  in words before the batch (ADR 0863).

## Proof
`packages/sdk/test/unique.test.ts` (the contract and the folding) and
`apps/runner/test/equipment.test.ts`: a tag written ` tm-x ` is kept `TM-X`; `tm-x`, `TM-X ` and
` TM-X` are refused by a create and by an update; a register re-imported with other case and stray
spaces creates nothing. With the folding taken out of the host's write, those fail.

## Amended 2026-11-26, after the second review of PR #491 (issue #498)
- **Invisible format characters are folded away** (Unicode `Cf`: a zero-width space, a joiner, a
  byte order mark), so `TM-03` and `TM-03` with a zero-width space after it are one tag.
- **A filter's value on a folded field is folded too** (`eq`, `neq`, `in`, `not_in`): a list
  filtered by ` tm-03 ` finds `TM-03`. Other operators compare as given.
- **A rule that gains `fold` is checked against the live records.** Its index now has its own name,
  so the reconciler's check for live records that break a new rule runs again, comparing
  `upper(trim(...))` (SQLite's, ASCII letters and spaces: what such a clash is made of). Two live
  records that would clash once folded refuse the change (`unique_conflict`, naming them) instead of
  staying side by side. The earlier wording, that records are folded "until each is next written",
  was wrong: only a write of the folded field folds it. A record whose folded field is not written
  again keeps its spelling, which the check above makes harmless.
- The stored and displayed value becomes upper case: the write-extension skill now says so, and not
  to fold a name or an address.

## Amended 2026-11-26, after the review of PR #502
- **A rule that gains `fold` folds the stored values in place.** Refusing only clashes left an old
  `tm-03` beside a new `TM-03`. The reconcile now folds each folded column of every record, in the
  Trash too, in one `UPDATE` per column (`CASE WHEN trim(c) = '' THEN NULL ELSE upper(trim(c))
  END`), before the rule's index is built. SQLite's `trim` and `upper` fold exactly as
  `foldUniqueText` does for printable ASCII only, so a value holding any other character (a letter
  outside A-Z, a tab, an invisible character such as a zero-width space) is not folded by SQL:
  while any exists the reconcile is refused (`unique_fold_rows`), with how many and the first five
  ids, and the way to fold them first in pages (write each one's value folded with `record.update`,
  a page of `record.list` at a time), then install again. So after any reconcile the stored values
  are what the host's fold makes, and the clash check (now exact) reports two that would be one.
  One statement per column whatever the size of the table: inside D1's 1,000 statements.
- The index name of a uniqueness rule is fitted (`fitName`) like the trigger names: one that fits
  is unchanged.
