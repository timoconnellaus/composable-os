# ADR 0708: The Knowledge pack's blocks and screens

Status: accepted, 2026-11-26 (stage 38, build step 6; the spec's Screens, criterion 14 and the
e2e journeys). Builds on ADRs [0424](0424-blocks-as-built.md),
[0440](0440-rich-text-is-data.md), [0442](0442-what-the-public-reads-of-content.md),
[0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0453](0453-pack-hooks-over-the-clients-operations.md), [0660](0660-pack-screens-in-the-admin.md),
[0700](0700-the-published-text-index-and-content-search.md),
[0701](0701-staff-read-of-published-versions-and-its-reach-for-pack-roles.md),
[0702](0702-acknowledgements-read-again-and-a-confirmation-nobody-changes.md) and
[0706](0706-the-knowledge-pack.md). Amends ADRs 0424 (a block another block brings that calls no
operation) and 0660 (a record screen opened by its route; a record's link for a fixed-role
account). No migration, no new operation, no audience widened.

## Context
Step 5 built the Knowledge pack's objects, tools and hooks. Its readers had nothing to read with:
no help centre for a business's site, no reader for staff, no way to confirm but a tool call, and
nothing in the admin. Two things the platform lacked surfaced on the way: a block of one pack
could not draw with another pack's block (the rich text renderer is Content's, and Knowledge does
not require Content), and the notices the host sends link to the procedure's record page, which a
fixed-role account (a coach, a cleaner) cannot open.

## Decision

**The blocks** (`packs/knowledge/blocks`), two skins sharing the hooks in
`@composable-os/pack-knowledge/client`, never the screens:

| Block | Skin | Who | Exports |
| --- | --- | --- | --- |
| `knowledge-help-centre` | web | anyone | `HelpCentre` (search, the topics with their pages), `HelpSearch`, `TopicPages`, `HelpTopicPage` |
| `knowledge-help-page` | web | anyone | `HelpPage` (one page and its related pages), `HelpArticle`, `HelpPageHead` |
| `knowledge-native-help` | native | anyone | `HelpCentreScreen`, `HelpPageScreen` |
| `knowledge-procedures` | web | staff | `Procedures` (by section, with search; one opens in the reader), `ProcedureReader`, `ProcedureScreen` |
| `knowledge-native-procedures` | native | staff | `ProceduresScreen`, `ProcedureScreen` |
| `knowledge-to-read` | web | staff | `ToRead` |
| `knowledge-native-to-read` | native | staff | `ToReadScreen` |
| `knowledge-read-status` | web | `knowledge:manage` | `ReadStatus` (counts; one procedure's people; CSV) |

Each shows what the host answers and decides nothing: what is published and its version, who must
read it, whether a confirmation counts, who may see read status. The help centre's search is
`content.search` asked for help pages, with the caller's own audience, so a visitor never gets a
procedure or a draft; it waits until the visitor stops typing (a quarter of a second) and each call
goes through the site's operation route, which passes the visitor's address (`forVisitor`, ADR
0940's limit per visitor). Rich text is drawn only by the Content pack's renderers
(`content-rich-text`, `content-native-rich-text`): React elements, never HTML; each heading's id
is the host's anchor (ADR 0700), so a result opens at its section.

**The confirmation is a person's deliberate act on the version shown.** The button is at the end
of the procedure's words and says what it confirms: `I have read and understood "Injuries"
(version 4)`. It confirms the version on screen (`content.staffGet`'s answer), never the version
the person's list names. It is drawn only when the host's list (`toRead`) says that version is
theirs to confirm (`myStanding`): when the list names a newer version, the reader asks the person
to read that one first and draws no button; when they are not asked, or have a confirmation that
counts, it says so. A refusal (`not_current`, `already_confirmed`, not found) is shown in words and
never taken as done. The spec rejects proof of reading (time on page, scrolling) as surveillance
that proves nothing ("What was weighed and rejected"), so the button is placed after the text and
is not held back until the person has scrolled: the person's statement, kept with its version, is
the evidence, as the spec decides.

**Read status shows the tool's answer only.** The screen is gated by `readStatus`; the hook keeps
the answer in the cache no longer than it is on screen (`gcTime: 0`, and the admin forgets a
screen's queries when it closes); a refusal shows the refusal and nothing else. The CSV is made
from the answer on screen when the person asks for it (`readStatusCsv`), a cell that starts like a
formula kept as text.

**The admin's screens** (stage 47's declaration in the manifest):

| Screen | Block, export | Gate (`opens`) | Who sees it |
| --- | --- | --- | --- |
| Procedures | `knowledge-procedures`, `Procedures` | `toRead`, `confirm` | every staff account, pack roles included (both tools are `anyStaff`) |
| To read | `knowledge-to-read`, `ToRead` | `toRead`, `confirm` | the same |
| As published (record screen on `knowledge.procedure`, as `procedureId`) | `knowledge-procedures`, `ProcedureScreen` | `toRead`, `confirm` | the same: a tab on the procedure's record page, beside the working copy |
| Read status | `knowledge-read-status`, `ReadStatus` | `readStatus` | admins and those granted `knowledge:manage`, a person only |

Help pages and their editor are the host's record pages; nothing is declared for them.

**A record screen opened by its route (amends ADR 0660).** `/s/<pack>/<screen>?record=<id>`
opens a record screen on that record, as its tab on the record page does; the route still renders
only a screen `screens.mine` lists, takes only an id, and passes it only to a screen that declares
`record`. **A record's link for a fixed-role account**: the small shell's layout, which answers
"not found" for every page but its home and its screens, now first sends `/x/<object>/<id>` (what
the host's notices link to, `notificationHref`) to `/s/<pack>/<key>?record=<id>` when
`screens.mine` lists a record screen on that object for the account. So "Please read: Injuries"
opens the reader for a coach. The rule is the shell's, for every pack: a coach following a class's
link (`/x/bookings.class/<id>`), "not found" before, now opens Bookings' Class list for that class,
the record screen the host lists for a coach on a class (`bookings.spec.ts` asserts it). The
admin's source still names no pack, and nothing here decides who may read the record: the
screen's own calls are the host's to answer.

**A block another block brings that calls no operation (amends ADR 0424).** `cos add` copies a
block of a pack that `product.ts` does not list when it calls no operation and another block
depends on it, one being added or one already copied (so `cos upgrade`'s "now depends on X (cos
add X)" works, and a deleted renderer can be added back): Content's rich text renderers, brought by Knowledge's blocks. Asked for by name, or
calling the host, a block's pack must still be listed. In this repository the admin's build and
the pictures' build resolve such a sibling import (`../content-rich-text/…`) to the one pack whose
`blocks/` holds it (`pack-blocks-plugin.ts`), as the blocks' tsconfigs do with `rootDirs`.

**What a fixed-role account is given of a procedure's section and pictures** (amended in the
PR's review round, see the amendment below; amends ADR 0701):

- **Sections: given with the procedure.** `publishable.staffNames` (SDK, contract-checked at
  install, and held again when the host reads, `namedTarget` in `visibility/staff-read.ts`) names
  single relation content fields to another object of the same pack, each as a field name or as
  `{ field, order }`. `content.staffGet` and `content.staffList` then give each record `names`: by
  field, the related live record's `id` (the field's own value), its `title`, and, with `order`,
  its value of that number field (`order`, null when empty), read from that object's table, those
  columns only, nothing of a deleted one. The Knowledge pack declares
  `staffNames: [{ field: "section", order: "order" }]`; its blocks group by the section's id, in
  the sections' `order` (those without one after, then by name), labelled by its name, so two
  sections with the same name stay two and the admin's order holds; no block asks for sections at
  all (the `useSections` hook and its `record.list` are gone).
  - **What a staff reader now learns of the related record**, a pack role's included: its id
    (already in the procedure's values), its title, and its declared order number. Nothing else.
  - **The rule** (second review): the title is read as it is on the record, so the related object
    must be one whose title every staff account may see: the contract refuses an object that is
    `publishable` (its title could be an unpublished draft's), declares `customer` (guardians are
    part of it), `customerVia` or `access` (row rules of its own), a title field that is not
    plain `text` (never an email, a phone, a choice), an order field that is not a `number`, a
    person, an organisation, another pack's object, a relation to many, a field outside the
    content, and `staffNames` without `staffRead`. A runtime extension declaring such a target
    is refused at install (`apps/runner/test/knowledge.test.ts`), and the read gives no name for
    one should the registry ever hold it.
- **Pictures: never asked for.** `media.serve` stays outside a pack-role account's reach (ADR
  0701), and a refused `media.serve` is audited (the media route calls it through the pipeline,
  whose pack-role refusal writes a `forbidden` row). So `content.staffGet` answers `pictures`:
  whether the caller reaches `media.serve` at all (`staffRightsReach`, one more statement on that
  read). When it is false the reader draws no `<img>` and shows "This picture cannot be shown
  here" with the alt text in its place. Serving a pack-role account a procedure's pictures stays
  undecided by the spec; the smallest correct change remains: put `media.serve` in
  `PACK_ROLE_STAFF_READS` and let it answer a pack-role account through the path it already has
  for outsiders (`outsiderShown`, which asks `core_published_media` for a current published
  version that shows the picture), with the staff-read source as that account's reader. Reviewed
  as step 2 was.

## Consequences
- A business's site gets a help centre by `cos add knowledge-help-centre knowledge-help-page`,
  its app by `cos add knowledge-native-help`; staff read and confirm in the admin, and in the app
  through a role client (`knowledge-native-procedures`, `knowledge-native-to-read`).
- A coach or a cleaner signs in to the admin and finds Procedures and To read in their small
  shell; a notice's link opens the reader.
- A coach's or a cleaner's Procedures, To read and reader make no call the host refuses: no
  section read, no picture (the coach e2e asserts no refused call). So no `forbidden` audit row
  and no `screens.mine` refetch comes from them.
- `content.staffGet` and `content.staffList` answer `names` for an object that declares
  `staffNames`, and `content.staffGet` answers `pictures` (the API contract changes with them).
- The native blocks are untried on real phones.

## Proof
- `packs/knowledge/test/blocks.test.tsx`: the reader and a help page drawn from one fixture by the
  web and the native blocks, every block type and the host's anchors in both; the confirm button's
  words and place; no button for a newer version, for someone not asked or already confirmed;
  procedures grouped by the host's section names, with no sections read; no picture asked for
  when the host says it is not served; a related page drawn; read status shows only the refusal
  to a refused account; nothing in a page is markup.
- `packs/knowledge/test/blocks.dom.test.tsx` (happy-dom): the confirm button pressed, web and
  native, with the list at version 3 and the reader at version 4: `{ version: 4 }` is sent; a
  refusal in the staff client's real `not_current` shape is shown as an alert and never as
  "Confirmed".
- `packages/sdk/test/staff-names.test.ts`: what the contract checks of `staffNames`: each refusal
  above (publishable, customer, customerVia, access, a title that is not text, an order that is
  not a number), with an order allowed.
- `apps/runner/test/knowledge.test.ts`: an install naming a publishable target is refused; a
  coach and a member get the section's id, name and order with the
  procedure (by id and in a list) while the coach is still refused the section; a deleted section
  gives none; `pictures` is true for an admin and a member, false for a coach.
- `packs/knowledge/test/client.test.ts`: `myStanding`, `knowledgeRefusal` (the tool's nested
  details), `bySection`, the CSV, the head, which hooks a public client gets, that search asks
  for help pages and procedures by object, and read status's `gcTime: 0`.
- `packages/create-composable-os/test/client-repo.test.ts`: `cos add knowledge-help-page` with
  only Knowledge listed brings Content's renderer; `cos add content-post` is still refused; the
  renderer, deleted, is added back by name.
- `apps/app/test-node/screens-plugin.test.ts`: the four screens resolve and build.
- `apps/app/e2e/knowledge.spec.ts`: a visitor searches the help centre and reads a page; a
  manager publishes a procedure, a member reads it in To read and confirms, and it leaves the
  list; the manager sees who has not; a coach follows the notice's link from the small shell,
  sees the section's name and no picture asked for, reads and confirms; after a read-again
  version it is to read again, a further version published while the reader is open makes the
  confirmation refused as not current (shown, never done), and the new version is read and
  confirmed; no call of the coach's is refused.

## Amendment, 2026-11-26 (the PR's review)
Before review, a coach's screens asked for sections (`record.list`, refused) on every list and
reader, and for each picture (`media.serve`, refused): each refusal wrote a `forbidden` audit row
and made the admin ask `screens.mine` again. The section's name now comes with the procedure
(`staffNames`) and the reader asks for no picture the host said it will not serve (`pictures`),
as above. `HelpPage` and `HelpPageScreen` call `onRedirect` from an effect, never while
rendering. `knowledgeRefusal` reads the admin's staff client's shape (the tool's inner details
only) as well as the typed client's.
