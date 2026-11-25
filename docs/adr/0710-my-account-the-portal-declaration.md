# ADR 0710: My account: the `portal` declaration, `me.portal` and the generated wiring

Status: accepted, 2026-11-24 (stage 48, build step 5; the spec's design, decisions 8 and 9).
Builds on ADRs [0401](0401-platform-packs-screens.md), [0402](0402-staff-and-customers.md),
[0424](0424-blocks-as-built.md), [0439](0439-what-a-customer-reads-through-their-own-records.md),
[0447](0447-the-signed-in-scope.md), [0540](0540-the-family-link.md) and
[0660](0660-pack-screens-in-the-admin.md) (the staff-side counterpart).

## Context

My account (stage 48) is the customer's own area on the business's website and in its app: base
sections (orders, agreements, family, payment method, details, sign-in and devices) and the
installed packs' own. Before this step the shell (step 1) took the packs' sections as a prop the
client built by hand, so a client app named every pack it had, and adding a pack meant finding,
copying and linking its block. Nothing said which pack sections a given customer has: a member
with no ticket would see an empty Tickets section, or the client would decide by calling each
pack's read (a rule in the client, ADR 0401).

## Decision

- **A shipped pack declares its sections** in its manifest, under `portal`, as it declares its
  staff screens under `screens` (ADR 0660): by key, a `label`, the `web` block and the `native`
  block of this pack with the component each exports (at least one of the two), an `order` (1 to
  59, before the base sections at 60 onward) and `has`, the objects of this pack that declare a
  customer whose records mean "this customer has something here". `has` is never empty: a page
  anyone may open ("Buy a pass") is a page the client links to, not a section. No pack code runs
  to decide whether a section shows.
- **The contract checks it in two places.** The manifest check (`portalIssues`, which the host
  runs too): the blocks are this pack's and of the right skin by name (`<id>-<name>` for web, never
  `-native-`; `<id>-native-<name>` for native), the exports are component names, the order is in
  range, `has` is non-empty and names this pack's objects with a customer. `cos ext check`, which
  has the files: each block's `block.json` is in the pack's `blocks/`, names this pack and the
  skin it is used for, exports the component, and lists only operations a customer or the public
  may call (the platform's customer and public contracts, or this pack's own tools open to them).
- **Shipped packs only.** A runtime extension declaring `portal` fails `extension.check` and
  install (`outside_audience`, as `screens`), and `me.portal` reads only installed rows with
  `source = 'shipped'` and `status = 'active'`: a runtime row's key is ignored.
- **`me.portal`** (customer, read, `hostInternal`, outside MCP and the assistant) answers the
  sections to show, in order: the base sections always, Payment method only when the caller pays a
  subscription that has not ended (`paysSubscription`), and each pack section whose `has` objects
  hold a record the caller reads as theirs: their own, or a live dependant's where the object
  opens to guardians (ADR 0540). That read is the seam's `ownReadSource` (ADR 0890's, shared
  with the calendar feed): the customer scope's rows without what is shared with every signed-in customer (ADR 0447) or reached through their
  own records (ADR 0439), so a notice everyone reads is nobody's section and a child's ticket (a
  ticket does not open to guardians) shows no Tickets to the parent. A pack section's key is
  `<pack>.<key>`, so two packs never collide and no pack takes a base key.
- **Two statements whatever is installed:** the installed shipped declarations (`json_extract`
  of `portal` only), and one row of `EXISTS` columns, one per named object and one for the
  subscriptions the caller pays. Not a compound `SELECT`: D1 refuses one of more than five terms.
  The checks split over more statements only past 25 (75 bound variables), which the repository's
  packs (seven objects) do not reach.
- **The release carries the declarations to client repos** in `contract/roles.json` under
  `portal`: per pack, its sections and the hooks factory its client entry exports
  (`createMembershipsHooks`, read from `packs/<id>/client/index.ts`; the contract test fails for a
  pack with a section and not exactly one `create<Name>Hooks`).
- **`cos add` writes the wiring.** Once an app has the account shell (`web-account`,
  `native-account`), every `cos add` copies the section blocks of each pack `product.ts` lists (and
  those they bring) for that skin, and writes `<app>/src/blocks/account-sections.gen.ts`: each
  section's key, pack, label, order, the copied block's component and the pack's hooks factory.
  `cos upgrade` writes it again and names section blocks not yet copied. The shell's
  `usePackSections` makes each pack's hooks once and renders the block with the hooks under the
  pack's id and the page's `returnUrl`; the shell then shows what `me.portal` lists, a pack's
  section only where the app has its block (`portalSections`). The page imports the generated
  file and names no pack. The blocks stay the client's (`cos diff`); the generated file is not.
- **A section's component renders with the pack's hooks and `returnUrl` alone:** every other prop
  is optional. Courses' `MyCourses`/`MyCoursesScreen` (`onContinue`) and Ticketing's
  `MyTicketsScreen` (`onOpen`) took a required callback; it became optional, and without it the
  row has no button or is not pressable.
- **The declarations in this stage:** Bookings (`bookings`, the timetable with the member's and a
  child's bookings, on `bookings.booking`), Memberships (`memberships`, on memberships and
  passes), Courses (`courses`, my courses, on `courses.enrolment`), Ticketing (`tickets`, on
  `ticketing.ticket`) and Programs (`training`, progress, on assignments and logged sets). Shop's
  Deliveries section is stage 37's to declare.
- **Orders is the one list of a customer's orders**, a base section (`my.list` on `order` and
  `orderLine`); no pack ships another. The receipt is a seam for stage 35: the row has a place for
  "Download receipt" shown only when the host's order read reports a receipt document (step 1's
  `receiptUrl`, null until then).

## Consequences

- Adding a pack to a client is listing it in `product.ts` and running `cos add` (or `cos upgrade`):
  its section is copied and wired, and shows to the customers who have something in it.
- A later stage's section (invoices, jobs, messages) is a `portal` declaration and its blocks, with
  no change to a client app that has the shell beyond `cos add` or `cos upgrade`.
- The section blocks' props are a contract now: a pack changing a declared export to require a
  new prop breaks the shell's rendering. The contract does not check props (it reads only
  `block.json` and the export's name); review and the e2e suite do.
- Not yet tried in a client app with every pack: the generated file is type-checked here against
  one pack's block and the shell, and its text is tested; step 8's e2e drives the page.

## Amended 2026-11-25: Delete my account is a base section (stage 48 step 7, [ADR 0715](0715-the-account-blocks-signing-in-again-in-place-and-one-subscriptions-part.md))

`me.portal` lists a ninth base section, `delete` ("Delete my account", order 99, last), for every
customer, so the shells take every section from the host's one list. Courses' declaration now
names `MyCoursesSection` and `MyCoursesSectionScreen` (its courses, then its subscription through
My account's one subscriptions part); a native shell gives each pack's screen `onManage`.
