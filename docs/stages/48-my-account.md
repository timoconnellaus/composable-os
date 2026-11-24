# Stage 48: My account

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Customer, Customer account, Sign-in address, Erase request,
Device session, Guardian and Dependant, Block, Pack, Headless entry, Order, Subscription,
Allowance, Agreement step), ADRs [0402](../adr/0402-staff-and-customers.md) (staff and customers;
deleting an account), [0419](../adr/0419-native-sessions-and-customer-sign-in.md) (device
sessions, the host sends codes), [0421](../adr/0421-the-client-app-binding-and-customer-sign-in.md)
(the binding; the sign-in address), [0424](../adr/0424-blocks-as-built.md) (blocks are copied and
the client's to change), [0439](../adr/0439-what-a-customer-reads-through-their-own-records.md),
[0447](../adr/0447-the-signed-in-scope.md), [0456](../adr/0456-the-hosts-sign-in-mail.md),
[0487](../adr/0487-the-payer-and-the-holder.md),
[0490](../adr/0490-the-course-plan-self-service-and-the-staff-side.md) (billing stays on the web;
the app reads only), [0540](../adr/0540-the-family-link.md),
[0642](../adr/0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) and
[0646](../adr/0646-erase-merge-and-retention-for-agreements.md); stages
[22](22-customers-and-audiences.md), [32](32-memberships.md), [37](37-shop.md) (its customer's
orders, read through `my.list`), [44](44-agreements.md) and [47](47-pack-screens.md) (the
staff-side counterpart: packs declare screens, the host lists them); issues
[#111](https://github.com/timoconnellaus/composable-os/issues/111) (a timeline customers can see),
[#113](https://github.com/timoconnellaus/composable-os/issues/113) (staff preview a client app as
a customer), [#114](https://github.com/timoconnellaus/composable-os/issues/114) (passkeys and
social sign-in), [#124](https://github.com/timoconnellaus/composable-os/issues/124) (invoices
beyond the provider's receipt), [#293](https://github.com/timoconnellaus/composable-os/issues/293)
(erase and a running subscription), [#302](https://github.com/timoconnellaus/composable-os/issues/302)
(erase and a former address); `packages/core/src/operations/me.ts`, `operations/person-link.ts`,
`operations/customer.ts`, `operations/subscription.ts`, `packages/core/open-operations.json`,
`packages/create-composable-os/src/blocks.ts`, `templates/client/apps/web/src/routes/account.tsx`
and `templates/client/apps/mobile/App.tsx`.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 9). Build may start. No
question for the owner is open.

- Step 1, the base headless entry and blocks over the existing operations, built on
  `feat/stage-48-account-blocks`, ADR 0714 (written with step 1, where the native link to the
  website is built).
- Step 4, `me.attention` and its setting, built on `feat/stage-48-attention`, ADR 0711: the eight
  kinds worked out in core (`packages/core/src/customers/attention.ts`, the operation in
  `operations/me-attention.ts`), the setting as `customer.settings` `attentionDays` (stored as
  `account_attention_days`), `open-operations.json`, the contracts and the template's clients
  regenerated, and `packages/core/test/me-attention.test.ts` (every kind, each one clearing, the
  setting at 14, another member's items, a fixed statement count whatever the packs, the family
  and the documents; after the PR's review, a pass listed only where its customer reads its uses
  and end, and a version that is not intact left out as `me.agreements.due` does). No migration. The attention
  block is step 7's.

- Step 5, the portal declaration, built on `feat/stage-48-portal`, ADR 0710 (no migration): the
  `portal` manifest key and its checks (`portalIssues` in the SDK; `cos ext check` reads each
  block's `block.json` for its pack, skin, export and that it calls only customer or public
  operations; a runtime extension's refused at check and install, ignored at run time);
  `me.portal` (`customers/portal.ts`, the seam's `ownReadSource`, two statements whatever is
  installed; `packages/core/test/me-portal.test.ts`); the declarations in Bookings, Memberships,
  Courses, Ticketing and Programs; the release's `contract/roles.json` `portal` with each pack's
  hooks factory; `cos add` copying the listed packs' section blocks once an app has a shell and
  writing `src/blocks/account-sections.gen.ts`, `cos upgrade` writing it again; the shells'
  `usePackSections` and the client's `portalSections`, so a shell shows what `me.portal` lists.
  Courses' my-courses blocks and Ticketing's native my-tickets block take their callback as
  optional, so a section renders with the pack's hooks alone.

- Step 6, the delete preview and its consequences, built on `feat/stage-48-delete-account`, ADR
  0713 (amends 0402; no migration): `me.deleteAccount` without `confirm` says what will happen,
  with `confirm` and `expect` it ends the subscriptions the member pays at period end, cancels
  their unpaid orders, then disables, signs out and opens the erase request, and the admins'
  notice says what was left (`customers/account-delete.ts`). A subscription under a cooling off
  ends with it, and one with a later end date at the provider is left for staff and said to
  charge. The recent sign-in before deleting is step 2's.

- **Steps 2, 3 and 3b built** on `feat/stage-48-email-change` ([ADR
  0712](../adr/0712-changing-the-sign-in-address-and-a-recent-sign-in.md), migration 0990). A
  recent sign-in: `me.email.change` and `me.deleteAccount` refuse a session signed in more than 15
  minutes ago (`sign_in_again`, HTTP 403), read from the session's own row; an app session
  exchanged from a browser sign-in keeps its age. Changing the sign-in address:
  `core_customer_email_change`, `me.email.change` (a code to the new address as the host's sign-in
  mail, the same answer for any address, limited per account and per mailbox by a reservation
  before the send), `me.email.confirm` (after a recent sign-in; five tries; a change closed by a
  racing confirm, cancel or newer request fails whole, migration 0990's trigger; refused while another Person, account or the erased list holds the address; else
  the account's address and the Person's primary email in one batch, other sessions ended, a
  timeline activity naming no address; after the commit the notice to the old address and the
  provider given the new one), staff `customer.changeEmail` and `customer.cancelEmailChange`
  (human admins, never finishing a change), and `customer.list` showing an open change (masked) and
  an open erase request. The email gatekeeper's sign-in kind takes the change's two fixed
  templates. The payments gatekeeper's `updateCustomerEmail` (`payments.customer.email`, the
  host's own call only). Erase reads the change records and takes a former address only while no
  other identified Person holds it, here and for addresses staff moved (#302 closed). Not built
  here: the blocks and the staff card's buttons (step 7), the delete preview (step 6).

Vocabulary: "My account" is the customer's own area on the business's website and in its app.
The draft called it the customer portal; "portal" stays only as the name of the manifest key and
the operation (`portal`, `me.portal`). The payment provider's own page for a card is "the
provider's page".

## Goal

A business's customers have one place, on its website and in its app, where they see everything
of theirs and do what is theirs to do: what needs their attention first (a document to agree to,
a card that failed, a balance due, a pass about to run out), then their bookings, memberships and
passes, courses, tickets and training, their orders and what was refunded, the documents they
agreed to, their family, their details, the card they pay with, the places they are signed in,
and, from their own side, changing their sign-in address and deleting their account. The business
copies one shell into its app and gets every installed pack's part of it; adding a pack later adds
its part. Nothing in the client app decides what is due, owed or allowed: the host answers.

## Who it is for

- **Gyms and studios (first).** A member's week is: what I am booked into, what I have left, did
  my payment go through, do I need to sign the new waiver, and the same for my child. Today each of
  these is a different block the business has to find, copy and link together, and some have no
  screen at all (details, devices, family, orders, deleting the account).
- **Trades and services (next).** Their customers rarely book; they receive. Their account holds
  quotes to accept, jobs and visit times, invoices to pay, documents and photos shared with them,
  and messages. Each arrives as a section (and, where it needs the customer, an attention kind)
  when its stage is built: Invoices and quotes (35), Jobs and projects (39), the Shared inbox (36)
  and client notes. They come through the same shell, with no change to a client app that already
  has it (decided by this spec, below). An organisation as the customer (a body corporate, a
  business client) is not a customer account today; a contact acting for their organisation is
  stage 35's to decide.
- **Ticketing and courses (built).** A ticket buyer's tickets and an online student's courses and
  subscription join the same shell.

## What exists today (from the code)

**Host operations a customer can call** (`packages/core/open-operations.json`):

- `me.get`, `me.update` (name and phone only: "Your email cannot be changed here"),
  `me.sessions.list`, `me.sessions.revoke`, `me.signOut`, `me.deleteAccount`
  (`operations/me.ts`); `me.family` (`operations/person-link.ts`).
- `my.list` / `my.get` over any object that declares a customer, including `order` and
  `orderLine` (`fields/order.ts`: state, amounts, refunds, tax, line titles). Stage 37 relies on
  this for a buyer's orders and adds no operation for them.
- `order.get`, `order.cancel` (unpaid only), `order.checkout`; `subscription.list`, `.get`,
  `.cancel`, `.resume`, `.change`, `.portal` (the provider's page for the card, only for someone
  who pays a subscription: `openPortal` in `subscriptions/subscriptions.ts`); `allowance.get`,
  `.list`; `me.agreements.due`, `.list`, `.get`, `.accept`, `.pdf` (self and live dependants).

**Pack tools a customer can call:** Memberships `mine` (with `personId` for a child), Bookings
`mine`, `family`, `book`, `cancel`, Courses `myCourses`, Ticketing `myTickets`, Programs `today`,
`progress`, `history`.

**Blocks** (`blocks/`, `packs/*/blocks/`): sign-in (web, native); agreements (`web-my-agreements`,
`native-my-agreements`, `web-agreements-due`, `native-agreements-due`, `web-agree`,
`native-agree`); `memberships-mine` and `memberships-native-mine`; `courses-my-courses`,
`courses-native-my-courses`, `courses-subscription`, `courses-native-subscription`;
`ticketing-my-tickets`, `ticketing-native-my-tickets`, `ticketing-order`; Bookings' timetable,
which holds "my bookings" and a parent's view of a child's (`bookings-timetable`,
`bookings-native-timetable`, through Bookings' `family` tool); Programs' today, session and
progress.

**The template**: `templates/client/apps/web/src/routes/account.tsx` and the Account tab in
`apps/mobile/App.tsx` show the name, the email, a sign-out button and a link to agreements.

**Staff side:** the Person page's customer account card
(`apps/app/src/components/people/customer-account-card.tsx`), read-only: address, status, last
sign-in. `customer.disable`, `.enable` and `.revokeSessions` exist as operations with no button.
Erase requests are listed under Settings → Storage.

**Sessions** keep when they were made: `core_customer_session.created_at` (web) and
`core_device_session.created_at` (app; a refresh rotates the tokens, not `created_at`). That is
the "signed in at" a recent sign-in reads.

### What is missing, inconsistent or scattered

1. **No block uses `me.get`, `me.update`, `me.sessions.*`, `me.family` or `me.deleteAccount`.**
2. **Changing the sign-in address is impossible** for a customer and for staff. Staff can change
   the Person's contact email, which then differs from the address the member signs in with
   (ADR 0421's note); the old address stays the sign-in key.
3. **Deleting an account has no preview and leaves money running.** `me.deleteAccount` disables
   the account and opens an erase request; a membership they pay keeps billing until staff act
   (and still after erase: #293), and an unpaid order stays open.
4. **Two family reads:** core `me.family` and Bookings' `family` tool answer the same question;
   Bookings' timetable blocks call the tool.
5. **Subscription management in two places:** `memberships-mine` and `courses-subscription` each
   list subscriptions, cancel, resume and open the provider's page. A member with both sees two
   "update card" buttons for one card.
6. **No "my orders".** `order.list` is staff-only; `my.list` on `order` answers a customer but no
   block shows it. Stage 37 planned its own "my orders" block. Receipts are only the provider's
   email (#124).
7. **"What needs my attention" has no host answer** except agreements. A failing card
   (`failingSince`, `past_due`), a payment waiting for the member (`incomplete`), a deposit's
   balance (`balanceDueAt`), an unpaid held order, a pass running out (the `allowance` count)
   are each in a different read.
8. **The shell names packs.** The template's account page links to agreements by hand.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **Deleting an account stops a monthly membership they pay at the end of the period already paid for. Nothing is refunded.** This is what cancelling does today |
| 2 | **"Needs your attention" lists eight things:** a document to agree to (for them or their child); a card payment that failed; a payment waiting for them to confirm with their bank; the rest of a deposit to pay; a class they started paying for and did not finish; a pass about to expire with classes still on it; a pass with no classes left; a free trial about to end. A cancelled membership about to stop is **not** listed (they chose it) |
| 3 | **7 days** ahead for a pass about to expire and a trial about to end |
| 4 | **Changing the sign-in address:** a code emailed to the new address, entered by someone signed in within the last 15 minutes. The old address is always told |
| 5 | **Staff may start a change** for a member who phones; only the code the member receives at the new address finishes it |
| 6 | **In the business's own app** a member sees their membership and opens the website to cancel, change plan or update their card (ADR 0490: billing stays on the web) |
| 7 | **Receipts to download: yes, but they wait for Invoices** (stage 35). This stage names the seam and builds nothing of it |
| 8 | **A parent** sees the child's bookings, memberships and passes and what the child needs to agree to, and books and cancels classes for the child. Changing a child's details and linking a child stay with staff |
| 9 | **Trades and services:** the owner asked what we think. Decided by this spec (below) |

## The design in one page

- **One shell, base-layer blocks.** `web-account` and `native-account`: a page with "Needs your
  attention" at the top, then sections. Base sections come with it: Your details, Sign-in and
  devices, Family, Orders, Payment method, Agreements (the existing blocks), Delete my account.
  Pack sections are the packs' own blocks.
- **Packs declare their sections**, as stage 47's staff screens: a `portal` key in a shipped
  pack's manifest naming a label, the web and native block and export, an order, and the objects
  whose records mean "this customer has some" (`has`). No pack code runs to decide it.
- **The host says which sections this customer has: `me.portal`.** Base sections always; a pack
  section when the pack is installed and enabled and the caller, or a live dependant, has a record
  of one of its `has` objects, counted through the visibility seam (a parent's section appears for
  a child's bookings only where that object opens to guardians). The client renders the answer.
- **The host says what needs attention: `me.attention`.** One customer read, computed in core from
  core records and behaviours only (agreements, orders, subscriptions, `allowance`), never from a
  pack's code and never by a client naming packs. Each item: its kind (a fixed vocabulary in
  core), whose it is (the caller or a named dependant), the record (object, id, title through the
  seam), when, and an amount where there is one. Later core primitives add kinds; a pack gets
  items by declaring behaviours.
- **`cos add web-account` writes the wiring.** It copies the shell and, for every pack in the
  client's `product.ts` with a `portal` declaration, that pack's section blocks, and generates one
  file mapping section keys to the copied components (`account-sections.gen.ts`). `cos add` of a
  new pack and `cos upgrade` regenerate it. The client's copy stays theirs (`cos diff`).
- **Orders is the one list of a customer's orders.** The base Orders section lists every order of
  theirs (`my.list` on `order` and `orderLine`), with lines, tax, refunds, deposits and balances.
  No pack ships another orders list: Shop's delivery state is Shop's own section (below).
- **Changing the sign-in address** is a host flow: the member asks with the new address, the host
  emails a code to it, the member enters it, and in one batch the account's sign-in address and
  the Person's primary email change, other sessions end, and after commit the old address is told
  and the provider is given the new one. A sign-in within the last 15 minutes is required. Staff
  can start the same change; it takes effect only when the member enters the code.
- **Deleting an account** gains a preview and consequences in the host: the member first sees what
  happens (subscriptions they pay end at the period's end, nothing refunded; unpaid orders
  cancelled; bookings, tickets and courses left for staff's erase), then confirms after a recent
  sign-in. The account is disabled and the erase request opened as today.
- **Money in the app is the website's.** The native shell shows memberships, passes, orders and
  subscriptions; cancelling, changing plan and the card open the business's website account page
  in the browser. No native block calls a billing operation (ADR 0490's lint stands).
- **Consolidation.** One base subscriptions part inside the shell, used by the Memberships and
  Courses sections; one Payment method section (shown when `me.portal` says the caller pays a
  subscription); Bookings' blocks read `me.family`, and its `family` tool stays for the API
  contract.

### What was weighed and rejected

- **Each pack contributes attention items through a declared tool.** A pack would decide what is
  "due", and a tool would run per pack per page view. Every case today is a core record or
  behaviour; reading them in core keeps one rule and one cost.
- **An account area built by the host and served in a frame or by URL.** Customer screens are the
  client's (blocks are copied and restyled, ADR 0424); the host serving markup on the company's
  domain would be a second UI layer and a new door.
- **The client app computing attention from `my.list` calls.** Rules in a client (ADR 0401), and
  the cut-offs would differ per app.
- **Changing the address by editing `primaryEmail`.** The sign-in address is the identity the
  company links to (ADR 0421); it changes only when the new mailbox is proved.
- **Deleting the account deletes data at once.** The erase request, staff's review and the due
  date stay (ADR 0402): some records may have to be kept, for the business to confirm with its
  accountant or lawyer, and staff say why.
- **Ending a deleted account's membership at once, or refunding the rest.** Decision 1: it ends at
  the period already paid for, which is what a cancel does; nothing new is charged or refunded.
- **Managing paid memberships inside the app.** Decision 6; the app stores' rules are for the
  business to check, and the website already does all of it.
- **A receipt document now.** Decision 7: one kind of document, built once with invoices.
- **One "account" pack.** The pieces are base records and identity; a pack cannot hold identity.

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| `me.attention` (core read over agreements, orders, subscriptions, allowance) and its setting | **Platform, new open operation** (customer) | A reviewed change (ADR 0402); read-only, bounded |
| `portal` manifest key and its contract checks; `me.portal` | **Platform, new declaration + open operation** | SDK manifest and contract, as stage 47's `screens`; runtime extensions refused |
| Changing the sign-in address: `me.email.change`, `me.email.confirm`, staff `customer.changeEmail`, `customer.cancelEmailChange` | **Platform, identity** | `packages/auth` customer auth, `customers/`, host mail, a migration; people only, never AI |
| A recent sign-in for sensitive customer acts | **Platform, identity** | Session age from the session row; new refusal `sign_in_again` |
| `me.deleteAccount` preview and consequences; admins told | **Platform** | Touches `subscriptions/` and `orders/`; amends ADR 0402 |
| Giving the provider the new address | **Platform, gatekeeper** | A new payments gatekeeper capability; host-called after commit |
| Base-layer blocks: shell, attention, details, devices, family, orders, payment method, change address, delete account (web and native) | **Base layer blocks** | `blocks/`, with a base headless entry over the typed client |
| Generated section wiring in `cos add` / `cos upgrade` | **Platform, client kit** | `packages/create-composable-os` |
| `portal` declarations in Bookings, Memberships, Courses, Ticketing, Programs | **Pack work** | Declarations only; their existing blocks |
| Memberships and Courses blocks use the shared subscriptions part (native: a link to the website); Bookings blocks use `me.family` | **Pack work** | Block changes, no tool changes |
| Staff card: actions, the pending address change, the open erase request | **Admin** | `apps/app/src/components/people` |

## The model

### Records

- **`core_customer_email_change`** (new): account, the new address (lower-cased and trimmed), the
  address it replaces, who started it (`customer` or a staff user id), a code hash and its expiry
  (15 minutes), tries left (5), when made, when confirmed, abandoned or replaced. One open per
  account; a newer one replaces it. Erase deletes them (after reading their old addresses, below).
- **No new record for attention or sections:** both are reads.

### The `portal` declaration

```ts
portal: {
  memberships: {
    label: "Memberships and passes",
    web: { block: "memberships-mine", export: "MyMemberships" },
    native: { block: "memberships-native-mine", export: "MyMemberships" },
    order: 20,
    has: ["memberships.membership", "memberships.pass"],
  },
}
```

- Blocks must be this pack's, of the right skin, and call only customer or public operations (the
  contract reads the block's `block.json`). `has` names this pack's objects that declare a
  customer and must not be empty: a catalogue-like page ("Buy a pass") is a page the client links
  to, not a section. Shipped packs only; a runtime extension declaring `portal` fails
  `cos ext check` and install, and the key is ignored at run time.
- The declarations in this stage: Bookings (bookings, a parent's view of a child's included),
  Memberships (memberships and passes), Courses (my courses and the course subscription),
  Ticketing (my tickets), Programs (today and progress). Stage 37's Shop declares a Deliveries
  section (`has: ["shop.shipment"]`) when it is built.

### Operations

| Operation | Audience | Who may | Risk | What |
| --- | --- | --- | --- | --- |
| `me.portal` | customer | the signed-in customer | read | Base sections; pack sections the caller (or a live dependant, where the object opens to guardians) has records of; `paysSubscription` (whether Payment method shows) |
| `me.attention` | customer | the signed-in customer | read | Items as below, soonest first, for the caller and live dependants on objects that open to guardians; agreements as `me.agreements.due` answers them |
| `me.email.change` | customer | the signed-in customer, signed in within the last 15 minutes | write (`hostInternal`) | Emails a code to the new address; answers the same whether or not the address is usable; limited per account and per address as sign-in codes are |
| `me.email.confirm` | customer | the same account, with the code | write (`hostInternal`) | Refuses an address held by another Person, another account or the erased-address list (told only now, to the person who proved the mailbox); else in one batch: the account's address, the Person's primary email (the old sign-in address removed from the Person's live addresses, kept in the change record; other addresses untouched), every other session ended (web and device), a timeline activity naming no address, the audit row; after commit, the notice to the old address and the provider given the new one |
| `me.deleteAccount` (changed) | customer | signed in within the last 15 minutes | write (`hostInternal`) | Without `confirm`: what will happen. With `confirm: true` and `expect` from the preview: in one batch as today, plus each subscription they pay set to end at its period's end (nothing refunded, nothing charged) and their unpaid orders cancelled; a changed preview is a conflict |
| `customer.changeEmail` | staff | admins (`users:manage`), `actors: ["human"]` | write | Starts a change for an account; the code goes to the new address and the member enters it on the website or in the app; the staff member never sees the code |
| `customer.cancelEmailChange` | staff | as above | write | Abandons an open change |
| `customer.list` (changed) | staff | as today | read | Also shows an open address change (its masked new address) and an open erase request |

All customer operations are `mcp: { expose: false }`, rate limited per account, and never queued.
A refusal for an old sign-in is `sign_in_again`; the blocks send the member through the code
sign-in and back.

### Attention kinds (core vocabulary; decision 2)

| Kind | The owner's words | From | Shown until |
| --- | --- | --- | --- |
| `agree` | A document to agree to (for them or their child) | `agreementsDue` (core) | accepted |
| `card_failing` | A card payment that failed | a subscription they pay in `past_due` or `unpaid`, or with `failingSince` | paid or ended |
| `confirm_payment` | A payment waiting for them to confirm with their bank | a subscription they pay in `incomplete` | confirmed or ended |
| `balance_due` | The rest of a deposit to pay | an order of theirs part paid, with `balanceDueAt` | paid or cancelled |
| `finish_paying` | A class they started paying for and did not finish | an order of theirs pending with a hold and `expiresAt` | paid, cancelled or expired |
| `pass_expiring` | A pass about to expire with classes still on it | an `allowance` holder of a fixed number of uses (a pass), theirs or a dependant's, whose validity ends within 7 days with uses left | lapsed, used up or renewed |
| `pass_used_up` | A pass with no classes left | the same kind of holder with no uses left and validity remaining | lapsed or a new holder |
| `trial_ending` | A free trial about to end | a subscription they pay whose trial ends within 7 days | the trial ended or the subscription cancelled |

- "Within 7 days" is one product setting, `account.attentionDays` (default 7, 1 to 30), changed by
  human admins only.
- A subscription item goes to the payer (ADR 0487); a pass item to the holder and their live
  guardians.
- A membership's per-period limit used up is not `pass_used_up`: it renews by itself.
- Later stages add kinds in core (`invoice_due`, `quote_waiting`, `message_unread`,
  `form_to_fill`, a visit to confirm).

### Receipts: the seam for stage 35 (decision 7)

The Orders section's row for a paid order has a place for "Download receipt", shown only when the
host's order read for a customer reports a receipt document for that order. This stage ships the
row without it and says the provider emailed the receipt. Stage 35 adds the document, its
customer read and that field; the section then shows the link with no client change beyond
`cos upgrade`. What a receipt must contain is for the business to confirm with its accountant.

### Tools

None new for packs. The assistant gets no customer operation.

### Screens

- **Customer web (base layer):** `web-account` (the shell and Needs your attention),
  `web-account-details` (name, phone, change sign-in address), `web-account-devices`,
  `web-account-family` (who you act for and who acts for you; "ask the business to link a child"
  is a sentence, not a form), `web-account-orders` (orders, lines, tax, refunds, deposits and
  balances), `web-account-subscriptions` (the shared part: state, next charge, cancel and keep
  going, change plan where the pack offers it), `web-account-payment` (opens the provider's page),
  `web-account-delete` (the preview, then confirm). The agreements blocks are sections as they
  are.
- **Native (base layer):** `native-account` and the same set as `native-account-*`, except that
  subscriptions and payment show state only, with "Manage on the website" opening the business's
  website account page in the browser (decision 6). Changing the sign-in address and deleting the
  account work in the app.
- **A parent (decision 8):** the Bookings section shows a child's bookings with cancel and links
  to the timetable to book for them; Memberships shows a child's memberships and passes;
  Agreements and Needs your attention show what the child needs to agree to. A child's orders,
  tickets, courses and training stay the child's.
- **Staff (admin):** the customer account card gains disable and enable, sign out everywhere, the
  open address change (start, cancel) and the open erase request with its due date. A core card,
  not a pack screen.

### Notifications

- Host mail (ADR 0456), not routine mail: the code to the new address, and "your sign-in address
  was changed" to the old one, naming the new one only partly (`a•••@example.com`), sent whoever
  started the change.
- Admins get a notice when a member deletes their account and something stays for staff to decide
  (future bookings, tickets, a dependant left without another guardian).

### What an AI may do

- Nothing on the customer side: every new customer operation is outside MCP and the assistant.
- `customer.changeEmail` and `.cancelEmailChange` are people only: identity is not
  AI-configurable. The assistant may read the account card's facts (`customer.list`) as an admin
  may, and say a change is pending.
- The attention setting is human admins only.

### Privacy, audit and erase

- `me.attention` and `me.portal` read only through the seam: a dependant's items only on objects
  that open to guardians (bookings, memberships, passes, agreements). Counts and titles only, no
  other person's names.
- `me.email.change` never says whether an address has an account before the code proves the
  mailbox. Codes are hashed. The audit row's addresses are redacted at erase as other addresses
  are (ADR 0019).
- **Issue #302, for this path.** Erase reads the change records for a Person's former sign-in
  addresses but takes one (deletes an account with it, puts it on the erased-address list) only
  while no other identified Person holds it now. An address a member moved away from and someone
  else later signed up with is therefore never taken by erasing the first member. The same check
  goes in the one place erase collects former addresses, so the build may close #302 whole; if it
  does not, #302 stays open for addresses moved by staff editing a Person's emails.
- **Issue #293.** A member's own deletion sets every subscription they pay to end at its period's
  end before the erase request is opened, so by the time staff erase within the due date it has
  ended or is ending. #293 stays open for what erase does to a subscription still running: erase
  staff start without the member deleting, a subscription paid by someone else, or one resumed
  meanwhile. This stage does not decide it.

## Out of scope

- Invoices, quotes, jobs, messages, contact preferences, shared files: their stages (35, 39, 36,
  30, client notes) add sections and attention kinds through this shell.
- A receipt or invoice document from the host (#124, stage 35): only the seam is named here.
- A customer adding or unlinking a child; a parent changing a child's details (staff only).
- Cancelling, changing plan or the card inside the app (decision 6).
- A timeline customers can see (#111); staff previewing as a customer (#113).
- Passkeys and social sign-in (#114); a second sign-in address per account.
- Organisations as customers (stage 35's question).
- What erase does to a subscription still running (#293), beyond the member's own deletion.

## Acceptance criteria

1. With Bookings, Memberships and Agreements installed, `cos add web-account` copies the shell and
   the packs' sections and writes `account-sections.gen.ts`; the page renders each section and the
   client's source names no pack by hand. Adding Courses with `cos add` adds its section.
2. `me.portal` for a member with no tickets omits Ticketing; after a ticket is bought it includes
   it. A parent whose child has a booking sees Bookings; a child's ticket shows no Ticketing to
   the parent.
3. `me.attention` lists, soonest first, an agreement due for the member and one for their child,
   a failing membership, a subscription waiting for the member to confirm a payment, a deposit's
   balance due, an unpaid held drop-in, a pass expiring in 3 days with uses left, a pass with none
   left and a trial ending in 5 days; a pass expiring in 10 days and a cancelled membership ending
   are not listed; each item goes once the cause is fixed. With the setting at 14, the 10-day pass
   is listed. Another member's items never appear (the isolation suite).
4. `me.attention` and `me.portal` each read a bounded number of statements (a statement-count
   test), whatever the number of packs installed.
5. A pack declaring `portal` with another pack's block, a native block in `web`, a block calling a
   staff operation, an empty `has`, or `has` naming an object without a customer fails its
   contract check; a runtime extension declaring `portal` fails `cos ext check` and install.
6. Changing the address: a member signed in within 15 minutes asks for a new address, gets a code
   there and enters it; they then sign in only with the new address, `me.get` shows it as
   `signInEmail` and `primaryEmail`, other sessions (web and app) are ended, the old address gets
   the notice.
7. Asking with an address that another Person or account holds, or that is erased, answers exactly
   as a usable one; the confirm then refuses with "this address is already in use at the
   business" and changes nothing.
8. A member signed in more than 15 minutes ago is refused with `sign_in_again` before changing the
   address or deleting the account; a wrong code five times ends the change.
9. A staff admin starts a change; it changes nothing until the member enters the code sent to the
   new address; the staff member's screen never shows the code; the assistant is refused.
10. Deleting the account: the preview lists a membership that will end at its period's end with
    nothing refunded, an unpaid order that will be cancelled, two future bookings and a ticket left
    for staff; after confirm, the subscription is set to end at period end at the provider (test
    mode and the fake), no refund or charge is made, the order is cancelled, the account is
    disabled, every session ends, the erase request exists, and admins are told what was left for
    them. A preview that changed meanwhile is a conflict.
11. Payment method shows only for someone who pays a subscription and opens the provider's page;
    the Memberships and Courses sections no longer carry their own card button.
12. Native: the Account tab is the native shell with the same sections and Needs your attention;
    subscriptions and payment show "Manage on the website", which opens the website's account
    page; the block lint still finds no billing operation in any native block.
13. Bookings' blocks read `me.family`; the `family` tool still answers for the API contract. A
    parent cancels a child's booking from the Bookings section.
14. Orders lists the member's orders with line titles, amounts in minor units shown in the
    deployment's currency, tax, refunds and deposits, and nothing of a child's. A paid order's row
    has no receipt link yet and says the provider emailed the receipt.
15. The staff customer card shows a pending address change and an open erase request, and an admin
    can disable, enable, sign the account out everywhere, and start or cancel an address change.
16. Erase deletes change records and takes a former address only while no other identified Person
    holds it (the #302 case: A moves away from an address, B signs up with it, erasing A leaves
    B's account).
17. `open-operations.json` lists the new customer operations; the audiences review signs them off.
18. E2E, one per journey: a member's account with attention items clearing; changing the address;
    deleting the account; a parent's account with a child.
19. The site: if it says members manage their account, `SITE.md` and the page say what is built.

## Dependencies

- **Built:** stages 22, 23, 24, 25, 31a, 32, 42, 44 (the agreements blocks and `agreementsDue`).
- **Stage 47** (spec agreed, not built): `portal` mirrors its `screens` key in the same manifest
  and contract files. Step 5 here after its step 1, or in the same files with care.
- **Stage 37, Shop** (spec agreed): its customer "my orders" block is replaced by this stage's
  Orders section; Shop declares a Deliveries section for its shipments instead (an overlap to
  note in its build).
- **Stages 30, 35, 36, 39, client notes, Forms** (not built): each adds a section or an attention
  kind; none blocks this.

## Migrations and numbers

Block **BF** in [`parallel-work.md`](../parallel-work.md): migrations 0990 to 1009, ADRs 0710 to
0719. Expected: migration 0990 (`core_customer_email_change`); the attention setting needs none.
ADRs the build writes:

- **0710**: My account: the `portal` declaration, `me.portal`, the generated wiring, Orders as the
  one list of a customer's orders (the receipt seam for stage 35).
- **0711**: Needs your attention: `me.attention`, its eight kinds and the days setting.
- **0712**: Changing the sign-in address and a recent sign-in (amends 0421; `sign_in_again`).
- **0713**: Deleting an account: the preview and its consequences (amends 0402; relates #293).
- **0714**: The app shows money and opens the website for it (amends 0490 with a dated note: a
  native block may link to the website's account page; it still calls no billing operation).
- ADR 0540 amended with a dated note: Bookings' blocks read `me.family`.

## Suggested build order

| Step | What | Files and areas | Beside | Collides with |
| --- | --- | --- | --- | --- |
| 1 | Base headless entry and blocks over existing operations: shell (without attention), details, devices, family, orders, subscriptions part, payment method; the template's account route and Account tab | `blocks/`, `packages/client`, `templates/client` | Everything | Anything editing `templates/client` |
| 2 | Recent sign-in (`sign_in_again`) | `packages/core/src/http/`, `packages/auth/src/customer-auth.ts` | 4, 5, 6 | Other work in `packages/auth` |
| 3 | Changing the sign-in address: record, operations, host mail, staff start and cancel, erase reading former addresses (#302) | `packages/core/src/customers/`, `operations/me.ts`, `operations/customer.ts`, `packages/auth`, migration 0990, `operations/erasure.ts` | 4, 5, 6 | Sign-in mail (ADR 0456), erase work (#302, #293), anything writing `core_person` emails |
| 3b | Giving the provider the new address | `packages/gatekeeper-payments`, `subscriptions/` | 4, 5 | Any payments gatekeeper work |
| 4 | `me.attention` and its setting | new `packages/core/src/customers/attention.ts`, reads of `agreements/due.ts`, `orders/`, `subscriptions/`, `allowance/` | 1, 3, 5 | Reads only; the settings registry |
| 5 | `portal` declaration, contract checks, `me.portal`; declarations in five packs; `cos add` generation | `packages/sdk/src/manifest.ts`, `contract.ts`, `packages/core`, `packs/*/index.ts`, `packages/create-composable-os/src/blocks.ts` | 3, 4 | **Stage 47 step 1** (same manifest and contract), any pack's manifest edits, Shop's pack |
| 6 | Delete account preview and consequences; admins told | `operations/me.ts`, `subscriptions/`, `orders/`, `customers/erase-requests.ts` | 1, 4, 5 | **`orders/` and `subscriptions/`** work (Shop step 1 onward, Offers, Invoices, point of sale), erase work (#293) |
| 7 | Attention, change address and delete blocks (web and native); Memberships, Courses and Bookings blocks consolidated; staff card | `blocks/`, `packs/memberships/blocks`, `packs/courses/blocks`, `packs/bookings/blocks`, `apps/app/src/components/people` | after 3, 4, 6 | Any pack block work in those folders |
| 8 | E2E, `SITE.md`, ADRs | `apps/app/e2e` or the fixture web app, `apps/marketing` | last | |

Three build sessions can run at once: (A) steps 1 and then 7's blocks, (B) steps 2, 3 and 3b,
(C) steps 4 and 6, with step 5 after stage 47 step 1.

## Size

**Medium.** Mostly consolidation and blocks; the new host work is two reads, one identity flow and
the delete consequences.

## Decided by this spec, open to override

- The shell is copied blocks in the client, not a host-served page.
- Packs declare sections; the host decides which show by "has a record", not by a tool.
- Attention is computed in core from records and behaviours; packs add nothing but behaviours.
- The 7 days is a setting (1 to 30, human admins), so a business can change it later.
- A membership's per-period limit used up is not "a pass with no classes left".
- The new sign-in address also becomes the Person's primary email; the old one is removed from the
  Person and kept only in the change record, for erase. Other addresses on the Person stay.
- Other sessions (web and app) end when the address changes; the one that confirmed stays.
- A code lasts 15 minutes and allows 5 tries; a newer request replaces an open one.
- The provider is given the new address after commit.
- Deleting cancels unpaid orders; bookings, tickets and courses are left for staff's erase.
- Changing the address and deleting the account work in the app; only money opens the website.
- Bookings' `family` tool stays, unused by blocks.
- Orders is the one list of a customer's orders; Shop shows delivery state in a Deliveries section
  of its own.
- **Trades and services customers (decision 9)**: their account needs quotes to accept, jobs and
  visit times, invoices to pay, documents and photos shared with them, and messages. Each arrives
  as a section, and an attention kind where the customer must act (a quote waiting, an invoice
  due, a visit to confirm, an unread message), when its stage is built: Invoices and quotes (35),
  Jobs and projects (39), the Shared inbox (36), client notes. All through this shell and
  `me.attention`; this stage builds none of them.

## Risks

- **Account takeover.** A stolen session could move the account to another mailbox: the recent
  sign-in, the code at the new address and the notice to the old one are the defences; review
  them as a security change. A staff-started change must never let staff complete it.
- **Address probing.** The change request must answer identically for any address; only the
  person holding the new mailbox learns it is in use.
- **Money.** Deleting an account changes subscriptions at the provider: it must only ever end at
  period end, never refund or charge, and must be tested against the provider's test mode.
- **Privacy.** A parent's account must show a child's records only where the object opens to
  guardians; the isolation suite aims at another member's child for both new reads.
- **Cost.** `me.attention` runs on every visit; it must stay bounded as packs grow.
- **Needs real things to verify:** the provider's page and the address update against a real test
  account; the native shell on real phones of both kinds; the app stores' rules on account
  deletion and on linking to the website for paid memberships, for the business to check; the
  first client's members trying it.

## Questions for the owner

None open. The interview answered every question the draft raised; the points left open were
decided the conventional way above.
