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
opens the reader for a coach. The admin's source still names no pack, and nothing here decides who
may read the record: the screen's own calls are the host's to answer.

**A block another block brings that calls no operation (amends ADR 0424).** `cos add` copies a
block of a pack that `product.ts` does not list when another block depends on it and it calls no
operation: Content's rich text renderers, brought by Knowledge's blocks. Asked for by name, or
calling the host, a block's pack must still be listed. In this repository the admin's build and
the pictures' build resolve such a sibling import (`../content-rich-text/…`) to the one pack whose
`blocks/` holds it (`pack-blocks-plugin.ts`), as the blocks' tsconfigs do with `rootDirs`.

**What a fixed-role account cannot have, and the smallest host change for each** (not made here:
neither is decided by the spec, and step 6 widens nothing):

- **A procedure's pictures.** `media.serve` is outside a pack-role account's reach (ADR 0701), so
  its reader shows "This picture cannot be shown here" with the picture's alt text in its place.
  The smallest correct change: put `media.serve` in `PACK_ROLE_STAFF_READS` and let it answer a
  pack-role account through the path it already has for outsiders (`outsiderShown`, which asks
  `core_published_media` for a current published version that shows the picture), with the
  staff-read source as that account's reader, so it is served only a picture a published
  staff-read version shows, never a draft's or another object's. Reviewed as step 2 was.
- **Section names.** A pack-role account reaches only staff-read objects; `knowledge.section` is
  not one, so `record.list` of sections is refused and the list is one list, the reader showing
  no section. The smallest correct change: answer a relation's display name inside
  `content.staffGet` and `content.staffList` for the relations among the published content fields
  (the section's name beside its id), which needs no new reach; or declare the grouping object
  readable by staff read. Until then a coach's Procedures screen is usable without them.

## Consequences
- A business's site gets a help centre by `cos add knowledge-help-centre knowledge-help-page`,
  its app by `cos add knowledge-native-help`; staff read and confirm in the admin, and in the app
  through a role client (`knowledge-native-procedures`, `knowledge-native-to-read`).
- A coach or a cleaner signs in to the admin and finds Procedures and To read in their small
  shell; a notice's link opens the reader.
- A refused section read costs a pack-role account one refused call per screen load (the admin
  asks `screens.mine` again after a refusal, at most every five seconds).
- The native blocks are untried on real phones.

## Proof
- `packs/knowledge/test/blocks.test.tsx`: the reader and a help page drawn from one fixture by the
  web and the native blocks, every block type and the host's anchors in both; the confirm button's
  words and place; no button for a newer version, for someone not asked or already confirmed; a
  pack role's list without sections; read status shows only the refusal to a refused account;
  nothing in a page is markup.
- `packs/knowledge/test/client.test.ts`: `myStanding`, `knowledgeRefusal` (the tool's nested
  details), `bySection`, the CSV, the head, which hooks a public client gets, that search asks
  for help pages and procedures by object, and read status's `gcTime: 0`.
- `packages/create-composable-os/test/client-repo.test.ts`: `cos add knowledge-help-page` with
  only Knowledge listed brings Content's renderer; `cos add content-post` is still refused.
- `apps/app/test-node/screens-plugin.test.ts`: the four screens resolve and build.
- `apps/app/e2e/knowledge.spec.ts`: a visitor searches the help centre and reads a page; a
  manager publishes a procedure, a member reads it in To read and confirms, and it leaves the
  list; the manager sees who has not; a coach follows the notice's link from the small shell,
  reads and confirms.
