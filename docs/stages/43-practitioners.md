# Stage 43: Outside practitioners

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Customers
and audiences, the visibility seam, Packs and blocks, Behaviours), [`CONTEXT.md`](../../CONTEXT.md),
ADRs [0402](../adr/0402-staff-and-customers.md), [0410](../adr/0410-the-seams-first-door-as-built.md)
to [0414](../adr/0414-pack-tools-run-as-the-customer.md), [0419](../adr/0419-native-sessions-and-customer-sign-in.md),
[0436](../adr/0436-pack-roles-and-the-door-role.md), [0439](../adr/0439-what-a-customer-reads-through-their-own-records.md),
[0445](../adr/0445-the-document-field.md) to [0449](../adr/0449-permissions-granted-one-by-one.md),
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md), [0540](../adr/0540-the-family-link.md),
[0552](../adr/0552-a-tool-a-person-approves.md), [0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md);
stages [22](22-customers-and-audiences.md), [41](41-programs.md) and [31](31-bookings.md) (step 6,
the family link); issue [#258](https://github.com/timoconnellaus/composable-os/issues/258) (roles and
grants add up); `packages/core/src/visibility/` (all of it, `guardians.ts` above all),
`packages/core/src/principals.ts`, `audiences.ts`, `pipeline.ts`, `pack-roles.ts`,
`pack-role-today.ts`, `packages/core/src/operations/query.ts` (the SQL validator),
`packs/programs` (`index.ts`, `layout.ts`, `tools.ts`), `packages/release/src/cloudflare.ts` and
`deploy.ts`.

Status: **spec agreed** (owner interviewed 2026-11-23 and answered the open questions the same day:
decisions 16 to 24). Build step 1, the location hint for new installs, is built
([ADR 0580](../adr/0580-a-location-hint-on-new-installs.md)).
Builds on stages 22, 23, 24, 41 and stage 31's family link. The first client is a gym; the first
practice is an outside practice it works with. Nothing here depends on stages 31b, 32b or 33.

This is not legal advice. The privacy section says what the platform does and what it does not
promise; the business and the practice decide, with their own advice, what the law asks of them.

## Goal

A business invites outside practitioners (a physiotherapist, a dietitian) to work with its clients
on the business's own host. A client agrees, in the app or on the website, before a practitioner
sees anything. The physiotherapist writes a rehab program the client follows beside their training,
and tells the coach what to avoid. The dietitian writes a nutrition plan the client reads, gives
them habits to tick off, and tells the coach what matters (cutting weight for a competition). The
client logs it all the way they log training. Each practitioner sees only what they wrote and
whether the client did it. Coaches see the restrictions and the exercise list, and how the client
is going with it, never the notes. The client can end it at any time, and it ends at once.

## What exists today (from the code)

- **Three audiences, three principals** (`principals.ts`, `audiences.ts`, ADR 0402): `staff` (a
  `core_user` with a role), `customer` (a Person signed in by an email code, `core_customer`) and
  `public`. A caller has exactly one audience (`audienceOf` is `principal.kind`); every operation
  lists the audiences it allows, `staff` by default; opening one to customers or the public is a
  reviewed change listed in `open-operations.json`. A principal the seam does not know sees nothing
  (`scopeOf`'s default).
- **Staff read everything.** The seam's staff scope is `all`: the plain `rec_*` view. A pack role
  (ADR 0436) narrows a staff account to its pack's tools and `record.get`/`record.list` on its
  pack's objects, whole objects, plus a "today" limit by date (ADR 0553, `pack-role-today.ts`,
  applied in the pipeline, not in the seam). An account holds one pack role and a pack role replaces
  its grants: roles do not add up today (issue #258 asks that they do).
- **`query.sql`, dashboards and exports read `rec_*` views.** The SQL validator refuses any name
  that is not a `rec_*` view (`operations/query.ts`). So a row in a `rec_*` view is readable by any
  staff account with `records:read`, by SQL, and by the assistant acting for one.
- **The family link** (ADR 0540, `visibility/guardians.ts`) is the precedent for "one Person's
  records reachable by another principal through a live link": a core record made only by a person
  on the staff, opted into per object (`customer.guardians`), read at the moment of every read,
  never cached, a guard statement in every write's batch (`core_person_link_guard`) so a link ended
  a moment before cannot be written through, the Trash and erase and merge handled, and a merge
  touching a live link is a person's act.
- **Field-level reads exist for customers only**: a customer source holds only the columns the
  object lists, and a document field's `private` parts are removed for customers and the public
  (ADR 0445, `visibility/records.ts`). Staff read whole documents.
- **Programs** (ADR 0448): `exercise` (the bank; every signed-in member reads it), `program` (a
  `publishable` layout document; kinds `class`, `client`, `course`), `assignment`, `session` (a
  copy of the plan of its version), `log` (one row per set; `recordedAs`, `recordedBy`). Layout
  notes are `private` unless `members: true`. Tools run as their caller (ADR 0414), so a customer's
  `logAdd` writes as the customer.
- **Sign-in**: staff by invite (`core_user_invite`, ADR 0455) and customers by email code
  (`core_customer`, its own Better Auth configuration, cookie and sessions), with the native token
  routes `/api/v1/auth/{staff,customer}/{code,sign-in}`. One address may hold a staff account and a
  customer account: they are separate tables and sessions.
- **`personApproves`** on a field, a setting or a tool (ADRs 0507, 0552): anyone may ask, a person
  decides.
- **Where data lives**: before step 1, `deploy.ts` created D1 databases and R2 buckets with a name
  only (`cloudflare.ts` `createD1`, `createR2`). Step 1 adds the location hint (ADR 0580).
- **Not anywhere**: a principal for someone outside the business who works on other people's
  records, consent recorded by a Person, authorship as a scope, rows staff cannot read, anything
  kept out of the assistant by rule.

## Decided at the interview (2026-11-23)

| # | Decision |
| --- | --- |
| 1 | Today the outside practice works from spreadsheets and videos and does not normally share with a client's coach. The owner wants something more collaborative and built in |
| 2 | A **practitioner** is an outside person with their own sign-in who sees only the clients linked to them |
| 3 | A **physiotherapist** adds a separate **rehab program** the client follows beside their training, and **restrictions** for the coach (for example: no overhead pressing for 6 weeks) |
| 4 | A **dietitian** is in scope too. They add a **nutrition plan** the client reads in the app (targets, meals, guidance); **habits and check-ins** the client ticks off, logged like exercises; and restrictions or **notes for the coach** (for example: cutting weight for a competition) |
| 5 | So the feature is "outside practitioners the business invites", built for one practice first and so that others can be added |
| 6 | Clients are existing members and the practitioner's own clients who are not members. A practitioner's client who later becomes a member keeps the same record |
| 7 | **Consent**: the client agrees themselves, in the app or on the website, before the practitioner sees anything, and can end it. This is health information |
| 8 | The practitioner sees **only what they themselves added and whether the client did it**; never memberships or payments |
| 9 | The **coach** (the business's staff) sees only the restrictions and the exercise list, not the practitioner's notes |
| 10 | A coach does **not** approve the practitioner's exercises before the client sees them |
| 11 | The client logs the practitioner's exercises the same way as training (sets, reps, done or not) in the app |
| 12 | Practitioners see each other's work for a shared client **only if the client chooses** to share it between them |
| 13 | **Who pays is not decided.** Nothing here depends on it |
| 14 | Build as soon as it is unblocked, in parallel with other work where possible |
| 15 | (Added by the owner the same day.) **One person can wear three hats**: the dietitian is also a coach at the business and trains there as a member. None of the three may leak into the others |

### The owner's answers to the open questions (2026-11-23)

| # | Decision | Was |
| --- | --- | --- |
| 16 | **Three hats, three sign-ins.** One person who is a practitioner, a coach and a member has three sign-ins on one email address, one hat each, with a clear switch between them. Accepted as designed | the design of decision 15 |
| 17 | **Coaches see how the client is going with the rehab, set by set**: the rehab exercise list and what was done, each set logged, as for their own programs. Never the practitioner's notes | question 1, (a) |
| 18 | **When a client ends consent, restrictions stay for the coaches until their end date**, and the client can remove them on the same screen as they end it | question 2, (a) |
| 19 | **When a client ends consent, the practitioner's private notes stay stored, readable by nobody**, until the client is erased or the practice asks for them (that is, asks for its own records to be handed over: an export of the practitioner's own notes, below) | question 3, (a) |
| 20 | **The business's AI assistant may read restrictions and the rehab exercise list only, and only if a person on the staff switches that on** (off by default). Never notes, nutrition plans or habits | question 4, (b) |
| 21 | **Consent is to that one practitioner.** The client can separately share with a colleague at the same practice | question 5, (a) |
| 22 | **For a child, a linked parent agrees**, for a child with no sign-in of their own | question 6, (a) |
| 23 | **A coach sees a member's current restrictions on the class list**: a flag beside the name, only for restrictions the client agreed to share | question 7, (a) |
| 24 | **New installs ask Cloudflare to store data in Oceania where it can**: a preference, not a guarantee | the privacy section's proposal |

**Stage 44 (Agreements)** ([spec](44-agreements.md), proposed) is intended to hold the care link's
consent as an accepted document (its "Stage 43: the care link's consent becomes an acceptance").
This stage does not wait for it: it builds its own consent record (below) so that it can become
one, with no change to what a client agreed to; if stage 44 is not there when step 4 is built, the
consent is written through one narrow function with the same fields, which stage 44 replaces with a
migration that copies the rows across.

## The design in one page

**A practitioner is a fourth kind of caller, beside staff, customers and the public.** They sign in
with their own account, made by a staff invite, by an email code, on the business's web app. Every
operation is closed to them unless it says otherwise, and opening one to them is a reviewed change,
as for customers.

**A client lets a practitioner in with a care link.** The practitioner asks; the client agrees on
the website or in the app, reading what the practitioner and the coaches will see; the agreement is
recorded with the words shown. While the link is live, the practitioner reaches that client's
records, and only the ones they wrote. The client ends it whenever they like, and it stops at once,
in the same way the family link does.

**What a practitioner writes is marked as theirs by the host,** and kept out of everything staff
read in bulk: SQL, dashboards, exports, search, summaries and the assistant. A person on the staff
sees, on screen, only what the object says staff see of it: the restrictions and the rehab exercise
list with how the client is going, set by set, never notes and never the nutrition plan or habits.
Staff cannot change it.

**The rehab program and the habits are Programs' own objects** (a program of a new kind, assigned to
the client and logged the same way). The restriction, the nutrition plan and the practitioner's
private notes are new objects in a small **Care pack**.

**One person, three hats, three sign-ins.** Each sign-in gives exactly one kind of caller. Nothing
in the host connects a person's practitioner account to their staff account or their member
account when it decides what they may see, so each hat sees what that hat sees and no more.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A staff account with a pack role limited to linked clients** (like the coach role) | Staff read every row: the staff scope is `all`, and `query.sql`, dashboards and exports read `rec_*` views whole. A pack role narrows *which operations* and *which objects*, not *whose rows*; its only row limit (today) lives in the pipeline, outside the seam, so a per-client, per-author rule there would be a second seam (ADR 0244). A staff account also brings the admin, the assistant, MCP, notifications and user lists with it. ADR 0402's reason holds: staff permissions are about what kind of thing you may do; this is about whose records they are. And with decision 15 a staff account would make "dietitian" and "coach" one account, which is the leak the owner asked us to prevent |
| **A customer who is linked to clients** (the guardian's shape) | A customer's scope is "my own Person's records, through the fields the client may read". A practitioner is not the record's subject: they need other fields (notes the client does not see), an authorship rule, and to author programs, which only staff do today. And every customer operation (booking, buying, the member's own reads) would be open to them as a practitioner. Two meanings of "customer" is how a mistake shows one person another's data |
| **A grant on a Person** (a flag "is a practitioner" on someone's member account) | Consent goes to a named practitioner, not to a Person who happens to be a member; and with decision 15 the same member account would then carry two hats in one session |
| **A pack only, with the pack's tools deciding who sees what** | Who may see whose health information is identity and policy. A tool deciding "is this my client?" is the pack hooking a write (ADR 0404, 0405). Rules live in the host |
| **A parallel model for rehab and habits** (rehab exercises, habit logs) | The log, dated sessions, the builder, the isolation tests and the client's Today all exist in Programs. A second model doubles all of them, and the client would log two ways |
| **Hiding practitioner rows from staff column by column in every staff path** | There are a dozen staff paths (lists, SQL, dashboards, exports, search, embeddings, summaries, digests, audit, Trash, timeline, MCP, the assistant). Keeping the rows out of the `rec_*` views closes them all at once; the seam then gives back, on screen, the part staff may see |

## What is platform work and what is pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| The `practitioner` principal and audience, their accounts, invites and sign-in | **Platform** | Identity |
| The **care link** (consent), its requests, ending it, sharing between practitioners, its guard in the batch | **Platform** (core records, the seam) | Who may see whose health information; the family link's shape |
| The seam's **practitioner scope**: linked client and author, field lists, shared work | **Platform** (`visibility/`) | One seam for every read and write |
| **Authored rows**: the host stamps the author and whether staff may see the row; such rows are not in `rec_*` views; staff see only the declared part, on screen, and never change them | **Platform** (reconciler, seam, record writes) | Must hold for every staff path and every actor |
| **Confidential document parts** (a layout's notes), removed for staff on authored rows | **Platform** (the document field, ADR 0445) | Same mechanism as `private` |
| Keeping care data from AI actors unless a person turned it on | **Platform** (seam, gate, assistant) | Policy is not AI-configurable |
| Notifications about authored rows (a restriction added or lifted), naming no content in email | **Platform** (declared on the object, sent by the host) | An automation reads as the organisation, which sees no authored rows |
| Erase, merge, the Trash for care links and authored rows | **Platform** | ADR 0320: erase reaches every store |
| The Oceania location hint on new installs | **Platform** (`packages/release`) | Where a new host's data is stored |
| Programs: kinds `rehab` and `habits`; sets and measures `check` and `amount`; the `practitioner` declarations on its objects | **Pack** (Programs, additions only) | Composition |
| The Care pack: restriction, nutrition plan, note; their tools, views, hooks and blocks | **Pack** (`packs/care`) | Composition |

## The model

### Words
A **practitioner** is an outside person the business invited (a physiotherapist, a dietitian), with
a **discipline** (a label) and a **practice** (the outside business they work for, an Organisation in
the host). A **care link** is a client's agreement that one practitioner may work with them; its
**consent** is the record of what the client agreed to, when and how. A **client** (of a practitioner)
is a Person with a live care link. **Practitioner work** is every record a practitioner wrote (its
**author**). A **restriction** is something the coach must avoid or know; a **note for the coach**
is a restriction of the kind "note". A **rehab program** and a **habits program** are Programs'
programs of those kinds. A **nutrition plan** is targets, meals and guidance for one client. A
**practitioner note** is the practitioner's own working note about a client, which only they read.
**Sharing** is a client's choice that one practitioner may read another's work for them.

### Platform: the principal, the account and sign-in
- **`PractitionerPrincipal`**: `{ kind: "practitioner", practitionerId, personId }`. A fourth
  audience, `practitioner`. `audienceOf` stays `principal.kind`, so a caller still has exactly one
  audience. No existing operation lists it, so on the day it ships a practitioner can call nothing
  but what this stage opens. The risk floor is the customers' (`read`, `write`); a practitioner's
  call is applied or refused, never queued; it is rate limited per account like a customer's. The
  audit log gains the outside actor `practitioner`.
- **The account** (`core_practitioner`): id (`prc_…`), the practitioner's own Person in the host
  (their name and contact, as staff see them), discipline, practice (an Organisation, optional),
  the sign-in address, status (`invited`, `active`, `ended`), who invited them and when, who ended
  it, when and why. One account per Person. Its sessions are its own, as customers' are; whether
  that is a third Better Auth configuration or the customer one with an account kind is the build's
  choice, recorded in its ADR, under two rules: **a practitioner session never resolves to any
  other principal, and one address may hold a staff account, a customer account and a practitioner
  account at once**, each signed in on its own.
- **Invited by a person on the staff**: `practitioner.invite { email, name, discipline,
  practiceId? }`, `practitioner.end { id, reason }`, `practitioner.list`, `practitioner.get`.
  Staff audience, `actors: ["human"]`, a new permission **`practitioners:manage`** (admins by
  default, grantable one by one as `people:link` is, ADR 0449). The assistant, MCP, automations,
  extensions and an import cannot invite or end a practitioner, whatever is granted.
- **Sign-in**: an email code on the business's web app (`/api/v1/auth/practitioner/code` and
  `/sign-in`, the same shape as ADR 0455's routes, the same limits). An address with no invite and
  no account is answered as any unknown address is. The invite email names the business and says
  what the account is for.
- **What a practitioner can never reach**, by any operation, by naming ids or by any surface: the
  admin, MCP, Code Mode, `query.sql`, dashboards, exports, the approval queue, settings, users,
  orders, payments, subscriptions, memberships, passes, bookings, tickets, courses' sales, the
  business's own programs and logs, any Person but their live clients (and of those only what the
  Person object lists for them: name and email), any other practitioner's work unless shared, and
  the business's assistant. They have no assistant of their own in this stage.

### Platform: the care link and consent
- **`core_care_link`**: id, practitioner, client Person, state, the request (asked at, the name and
  address the practitioner typed, an optional message), the consent (agreed at, the consent text's
  version and its hash, by which customer account, on the web or in the app), the end (at, by whom:
  `client`, `practitioner`, `staff`, `erase`, `merge`; a reason from a list, no free text). States:
  `requested` → `live` → `ended`, or `requested` → `closed` (declined, withdrawn or expired after 30
  days, guess). One live or requested link per practitioner and client (a partial unique index).
  **Never a practitioner to their own Person** (a CHECK against the account's Person, and the
  request refused the same way as an unknown address).
- **Asking**: `care.request { name, email, message? }` (practitioner). The host matches the address
  to a Person **without telling the practitioner**: the answer is the same whether the address is a
  member's, a former client's, an unknown one or the practitioner's own. The host emails the address
  ("[practitioner], [discipline] at [practice], asks to work with you through [business]"), with a
  link to the website's consent page. With customer sign-up `invite_only`, a request lets that one
  address sign in (as a staff invite does). Requests are limited per practitioner (20 a day, guess).
  **No Person is created by a request.** The practitioner sees only what they typed and "waiting".
- **Agreeing**: `me.care.requests` (customer, read) and `me.care.consent { requestId }` (customer,
  write: a reviewed change). The client signs in with the address the request went to; first
  sign-in creates their Person as it does today, or links the member's existing Person. The page
  shows the consent text, filled in: who the practitioner is, and that the consent is to them alone,
  not to their practice (decision 21); what they will see (only what they add and whether you did
  it; never your memberships, payments or your training with the gym); what the coaches will see
  (the restrictions and the exercise list they add and how you are going with it, set by set
  (decision 17); a flag beside your name on a class list while a restriction is current (decision
  23); and that you are linked to them; never their notes, your nutrition plan or your habits);
  that the business's AI assistant may read the restrictions and the exercise list only if a person
  at the business turns that on (decision 20), and never the rest; where the data is stored and that
  it may be overseas; that you can end it at any time and what happens then (restrictions stay for
  the coaches until their end date unless you remove them; the practitioner's notes are kept, read
  by nobody in the product, because the practice may have to keep its clinical records; the
  practice may be given a copy of its practitioner's own notes; they are deleted if you ask for
  your records to be erased); who to ask for your
  records. The link becomes `live` in the same batch that records the consent. `me.care.decline` closes it.
  Declined, withdrawn and expired look the same to the practitioner ("closed").
- **The consent record** (in `core_care_link`, or a `core_care_consent` row it points to: the
  build's choice) holds what an accepted document will hold, so that stage 44 (Agreements) can
  take it over without changing what anyone agreed to: the text's identity (version and hash) and
  the filled-in words as shown, who accepted (the customer account and the Person, and for a child
  the guardian and the dependant), for whom and with whom (the client Person and the practitioner
  account), when, on which channel, and its end. It is written once and never edited; ending a link
  records the end beside it. Nothing in this stage depends on stage 44.
- **A child** (decision 22): a guardian linked to a dependant by the family link (ADR 0540) agrees
  for a dependant **who has no sign-in of their own**. The practitioner asks with the guardian's
  address and the child's name (the same blind answer as any request); the guardian, signed in,
  sees the request and chooses which of their linked dependants it is for (`me.care.consent {
  requestId, forPersonId }`, refused as `not_found` unless the family link is live and the
  dependant has no customer account); the consent records the guardian's account and the
  dependant. The guardian reads the child's care records as the child would, through
  `customer.guardians` on the Care and Programs objects, and may end the link. A dependant with a
  sign-in of their own agrees themselves, as any client does. **Unless stage 44's minor mark is set:**
  if the Person carries stage 44's "is a minor" mark, the care consent follows stage 44's rule
  (a linked guardian agrees, or staff record a paper form), so the two stages never disagree. A
  guardian whose family link ends can no longer end or read it; the dependant, once they sign in,
  can.
- **The consent text** is the platform's, versioned, with the business's name, contact and privacy
  policy address filled in from settings. A human admin may add to it (a `personApproves` setting);
  a new version does not change what earlier clients agreed to, and every consent keeps the version
  it was given under.
- **The same record carries over** (decision 6): a non-member client is a Person from their first
  sign-in. When they join, they buy as that signed-in Person, or staff adding them meet stage 16's
  duplicate warning on the address and use the same Person.
- **Ending**: by the client (`me.care.end { linkId }`, customer), by the practitioner (`care.end {
  linkId }`), by staff ending the practitioner's account (every link of theirs), by erase, or by a
  merge. **Reads stop at once**: the link is read in the statement that needs it, never cached. A
  practitioner's write carries a guard statement in its batch (`core_care_link_guard`, as
  `core_person_link_guard`), so a link ended between the check and the commit is not written
  through; the practitioner is told `not_found`.
- **What the practitioner wrote stays the client's** when a link ends. The client keeps reading
  their rehab program, nutrition plan, restrictions and their own logs; sessions already dated stay
  and can still be logged; nothing new is added.
- **Restrictions when a link ends** (decision 18): the screen where the client ends the link lists
  the practitioner's active restrictions and lets them remove each (`me.care.end { linkId,
  removeRestrictions?: [ids] }`, in the same batch). Those kept stay visible to coaches, as before,
  until their end date (the timed move to `expired`); one with no end date stays until the client
  removes it later, from My restrictions (`me.care.restrictionRemove`, the client's own act, for a
  restriction whose link has ended). Nobody else changes them: the practitioner has no access and
  staff never change an authored row.
- **The practitioner's private notes when a link ends** (decision 19): they stay stored and are
  **readable by nobody in the product**: not the practitioner, staff, the client, a shared
  practitioner or an AI actor. A new live link with the same practitioner makes them readable to
  that practitioner again.
  - **The tension, plainly.** The client ended sharing. But health practitioners usually have to
    keep their clinical records for years. Deleting the notes could put the practice in breach,
    and leaving them readable would ignore the client's decision. So they are kept, closed, and
    leave the product only as the practice's own copy, or not at all.
  - **The practice asks for its records** ("the practice asks for them"): a person on the staff
    with `practitioners:manage` makes an export (`care.notesExport { practitionerId, personId,
    reason }`).
    - **Who may make it:** a person only. It is `actors: ["human"]`: never the assistant, MCP, an
      automation, an extension or an import, and an AI cannot even ask for it.
    - **What it holds:** only that practitioner's own notes about that client (their text, dates and
      what each was about). Nothing else of the client's: no programs, logs, plan or restrictions,
      and no other practitioner's work, shared or not.
    - **Who receives it:** it is handed to that practitioner, at their account's address, or, if
      they have left, to their practice, at its Organisation's address, as a one-time download
      that expires. It is never shown in the admin, so the person who makes it does not read it.
    - **The audit:** who made it, when, for which practitioner and client, why, the number of
      notes, and who received it. No values.
  - **Deletion.** The notes are deleted when the client is erased (as for every authored row about
    them). Removal outside erasure (`care.notesRemove { practitionerId, personId, basis }`) is also
    `actors: ["human"]`, needs `practitioners:manage`, deletes the notes unseen and is audited. It
    has two allowed bases and no others:
    - `client`: the client asked the business, and the business handles the request (it may first
      make the practice's export);
    - `retention-ended`: the practice asks after its own retention period has ended, and says so in
      the request.
    The practice cannot delete records it may still be obliged to keep.
- **Live** means: `live`, the practitioner's account `active`, and the client's Person out of the
  Trash. A Person restored from the Trash gets the link back (it never ended).

### Platform: sharing between practitioners (decision 12)
- **`core_care_share`**: client, from practitioner (whose work), to practitioner (who may read it),
  made at, ended at. Made and ended only by the client: `me.care.share { fromLinkId, toLinkId }` and
  `me.care.unshare` (customer, write). One direction: sharing the physiotherapist's work with the
  dietitian does not share the dietitian's with the physiotherapist.
- **What is shared**: the work's records as the author reads them (programs, sessions and their
  logs, the nutrition plan, restrictions), **read only**. **Never the author's private notes**
  (`care.note` is not shareable). The reading practitioner's link must be live; the author's may
  have ended, so a client handing over from a practitioner who left to a new one can share the old
  work. **A colleague at the same practice** (decision 21) is no different: consent is to one
  practitioner, and a client who wants a colleague to cover (a holiday, a second opinion) agrees to
  a care link with the colleague and shares the first practitioner's work with them.
- Ending either link, or the client ending the share, stops it at once.

### Platform: the practitioner scope in the seam
An object opts in with a **`practitioner`** declaration (SDK and contract; shipped and reviewed
extensions only, as `customer` is: a runtime extension is refused):

```ts
practitioner: {
  author: "author",        // read-only relation the host sets: the practitioner account
  client: "person",        // optional: the Person the record is about; makes the row personal
  read: [...], write: [...],  // what the practitioner reads and writes of their own rows
  shared?: true,           // the row is readable by every practitioner (the bank), not personal
  staff?: { read: [...], when?: { field: "kind", in: ["rehab"] } } | false,
  ai?: false,              // never to an AI actor (the default for every authored row)
  inherit?: "session",     // author and staff-visibility copied from this parent at create
  notify?: { create: "coaches", moves: { lifted: "coaches" } },
}
```

- **The scope** (`visibility/practitioners.ts`, the one place, as `guardians.ts` is): for a
  practitioner on a personal object, the rows whose client is one of their **live** clients and
  whose author is **them**, or a practitioner whose work that client **shares with them** (read
  only); the `read` fields only. On a `shared` object, every live row, `read` fields. Anything else:
  nothing, and the object does not exist for them. Their own Person is never a client.
- **Writes**: create and change only rows they authored, for a live client, `write` fields only;
  the author is set by the seam to the caller and never taken from input; `my.create`'s
  `forPersonId` names the client and must be a live client, else `not_found` exactly as for a
  Person that does not exist; each write carries the care link's guard.
- **Reuse of the generic operations**: `my.list`, `my.get`, `my.create` and `my.update` (and
  `record.publish`, `record.versions`, `record.version` on rows they authored) are opened to the
  `practitioner` audience; the seam decides by the principal. A pack tool called by a practitioner
  runs as the practitioner (ADR 0414's rule, extended).
- **Authored rows** (every row with an author, on an object that is not `shared`):
  - the host stamps two read-only values at create: the author, and whether staff may see the row
    (from `staff.when`, or copied from the parent named by `inherit`: an assignment from its program,
    a session from its assignment, a log from its session). Nobody changes them after, the host's
    own later writes included;
  - **they are not in the `rec_*` views.** The reconciler gives such an object its `rec_*` view of
    rows with no author (what SQL, dashboards, exports, search and embeddings read) and a second view
    only the seam names (the SQL validator already refuses any name that is not `rec_*`). The
    customer's and the practitioner's sources read the second view;
  - a **person on the staff** sees an authored row only where it is staff-visible, only its
    `staff.read` fields, with its confidential document parts removed, and only on the reads that
    show a record on screen (`record.get`, `record.list`, the Care tab's and the coach's reads):
    never in `query.sql`, dashboards, exports, counts in reports, search, summaries, embeddings,
    the digest, the Trash list, the timeline or audit values. **An AI actor** (the assistant, MCP,
    and an automation's AI steps) sees none of it unless the AI setting (decision 20) is on, and
    then only restrictions and rehab exercise lists;
  - **staff cannot change an authored row** (`authored`, for every staff actor), nor delete or
    restore it; only its author, the host and erase do. Staff's lever is ending the link or the
    account;
  - the audit log records changes to authored rows by field name only, no values (ADR 0019's
    redaction, applied at write).
- **The seam learns whether a person or an AI is asking.** Today `Viewer` holds only the principal;
  a staff viewer gains its actor, so the seam can give the on-screen staff part to a person and
  nothing to an AI.
- **The client's own reads** of authored rows are the object's `customer` declaration, as for any
  record of theirs (their rehab sessions on Today), from the second view.

### Platform: confidential parts of a document
A document node may declare `confidential: true` beside `private`. On an **authored** row, the seam
removes confidential parts for staff (and for an AI actor, if the setting is on); the author and
practitioners it is shared with read the whole document; the client reads it by the `private` rules
as today. On a row with no author nothing changes: a coach's own notes are the coach's. Programs'
layout and session plan notes become `confidential` as well as `private`, so **a physiotherapist
writes notes in the same builder** and the coach sees the exercise list without them.

### Pack: Programs (additions only)
- **Kinds**: `rehab` and `habits` beside `class`, `client`, `course`. Staff may see a practitioner's
  `rehab` programs (`staff.when: kind in [rehab]`) and never `habits`.
- **Measures and sets**: an exercise's measure gains `check` (done or not) and `amount` (a number
  with a unit, such as body weight in kg or water in litres); the layout's set union gains `check`
  and `amount`; the log gains `done` and `actualAmount`. A **habit** is a bank entry with one of
  these measures and the theme `habit`; a daily habit is an item in a session each day; a weekly
  check-in is an item on one day of the week. Additions to the schema, so existing documents stay
  valid.
- **Declarations**: `exercise` is `shared` (practitioners read the whole bank and may add entries,
  marked with their author, which members and staff see like any; only the author and staff change
  them); `program` has an author and no client (a practitioner's program can be given to several of
  their clients; staff may see `rehab` ones on screen); `assignment`, `session` and `log` have the
  client `person` and `inherit` the author and staff visibility from their parent. Staff's part of a
  rehab session and its logs (decision 17): the plan without its notes, and each set as logged
  (done or not, reps, weight, amount, when), as on their own programs; never a note on a set or a
  session. Habits sessions and logs are never staff-visible.
- **Tools opened to practitioners** (each a reviewed change): `assign` (their own program, to a live
  client), `sessionGet`, `history` and `progress` for a named client (their own sessions only),
  `logAdd` and `logUpdate` for a client in clinic (`recordedAs: practitioner`), and the builder's
  reads and writes through `my.*`. `draft` and `importText` stay staff only.
- **The client** logs rehab and habits with the same `today`, `sessionGet`, `logAdd`,
  `sessionComplete` tools; the host copies the author onto each log.

### Pack: Care (`packs/care`)
| Object | What | Declarations |
| --- | --- | --- |
| `care.restriction` | Client, author, kind (`restriction`, `note` for the coach), title ("No overhead pressing"), what the coach should know (text), body areas (Programs' list), exercises to avoid (bank refs, optional), from, until (empty: until lifted), state (`active`, `lifted`, `expired`, `removed`) | Personal; staff see it (every field) while `active`, including after its link ends (decision 18); the client reads it; `states` with `expired` as a timed move at `until` (`states.after`), `lifted` by its author, and `removed` by the client once the link has ended (decision 18); `notify` coaches on create, `lifted` and `removed` |
| `care.nutritionplan` | Client, author, targets (energy, protein, carbohydrate, fat, water, each optional), meals (a document: days, meals, items, amounts), guidance (rich text) | Personal; `publishable` without its public half (the client reads the published version; the practitioner edits a working copy); **staff: never** |
| `care.note` | Client, author, about (an optional record and path: a session, an item), body (rich text), date | Personal; read and written only by its author; **not shareable, not the client's, staff never** |

Tools: `restrictionAdd`, `restrictionLift`, `restrictionsFor { personId }` (staff, a person: the
active restrictions and which of a program's exercises they name, by exercise and body area, worked
out in the host; the builder and the coach's client view show it as a warning, they never block),
`planPublish` (the practitioner's own; decision 10: no coach approves it), `noteAdd`, `noteUpdate`.

**On the class list** (decision 23): a coach reading a class's bookings (Bookings' class list, the
coach pack role of ADR 0553) sees a flag beside each member with a current restriction (`active`,
staff-visible, so only restrictions under a consent the client gave); opening it shows those
restrictions as the coach's client view does. Nothing else of care data is on the list. It needs
the coach pack role to read `care.restriction` (an amendment to ADR 0436 that issue #258 reshapes),
and the flag is worked out in the host (`restrictionsFor` over the class's members), not in the
block.

### Notifications (who is told what)
| Event | Told | What it says |
| --- | --- | --- |
| A request | The address | Who asks and a link to the consent page |
| Consent given, declined or ended | The practitioner | "[client] agreed" / "closed" / "[client] ended your access" (no reason) |
| A restriction or coach note added, lifted, or removed by the client | **Coaches**: staff who assigned the client a live program, plus the staff named in the Care setting "tell about restrictions" (default: admins) | In the host: the client's name, the practitioner's name and discipline, and the restriction's title and text. **By email or push: only "a practitioner added a restriction for [client]: open the app"**, no content |
| A program, plan or habit given | The client | "[practitioner] added [a rehab program] for you" |
| Sharing started or ended | Both practitioners | Who, and for which client |
| The practitioner's account ended | Their live clients | "[practitioner] no longer has access; what they added stays yours" |
| A client erased | The practitioner | "A client's records were removed" (no name) |

Notes, nutrition plans and habits are never in any message to anyone but their client. These are
the host's own messages (declared by `notify`), not pack automations: an automation reads as the
organisation, and authored rows are not there for it.

### Identity: one person, three hats (decision 15)
One human can be a practitioner (the dietitian), a coach (staff) and a member (customer).

- **Three accounts, three sign-ins, the same address allowed.** A staff account (`core_user`), a
  customer account (`core_customer`) and a practitioner account (`core_practitioner`), each
  signed in on its own, each session resolving to exactly one principal. **A clear switch**
  (decision 16): the web app always shows which hat a screen is for (practitioner, staff, member),
  and a switch lists the hats this browser is signed in as and offers to sign in as another (an
  email code for that account). Switching changes which session the next screen uses; no screen
  and no call ever uses two. The member app is a customer's (and a staff member's, ADR 0451);
  practitioners work on the web.
- **Practitioner reach is its own account**, not a role on the staff account and not a grant on the
  Person. So ADR 0436's "one pack role, which replaces grants" does not touch it, and when issue
  #258 makes staff roles and grants add up, they add up **within** a principal: a staff account's
  coach role plus the desk's permission. Across principals nothing adds up: a call is made by one
  hat. Least privilege by default in each.
- **What each hat sees**:
  - *As the practitioner*: their live clients, only their own work and what clients share with them.
  - *As a coach*: what any coach sees: every client's restrictions and rehab exercise lists, on
    screen, without notes, and nothing of nutrition plans, habits or practitioner notes, including
    their own. The staff account gains nothing from the practitioner account: the seam never looks
    from one to the other.
  - *As a member*: their own records, like any member. If another practitioner works with them,
    they agreed to it as a customer like any client.
  - *A client for whom they are both dietitian and coach*: as the coach, the coach's view; as the
    dietitian, their own work. Each screen shows what its hat may see. They never get one view with
    both, and they never reach another practitioner's (the physiotherapist's) notes either way. As a
    coach they see the physiotherapist's restrictions and exercise list as every coach does.
- **Conflicts the host refuses**:
  - **A practitioner as their own client**: a care link from a practitioner account to its own
    Person is refused (a CHECK; the request answers as for an unknown address). Their member account
    can still be another practitioner's client.
  - **Consent to "the dietitian" is not consent to "the coach"**: a care link names a practitioner
    account and widens only that account's reach. The same human's staff account sees exactly what
    every other coach's account sees; the consent text says what coaches see, so the client agreed
    to that too, and only that.
  - **Writing as the wrong hat**: rows a practitioner wrote can be changed only by that practitioner
    account. The same person's staff account is refused (`authored`), so a coach cannot edit "their
    own" nutrition plan from the admin.
  - **Inviting yourself**: a staff member with `practitioners:manage` may invite their own address
    as a practitioner (it is how this person gets the account); the invite is audited, and the
    staff account gains nothing from it.
  - **Messages**: a restriction notice goes to the staff account; a consent notice to the
    practitioner account. When they share an address the email says which hat it is for.
- **Merge and erase**: a staff user is not a Person, so nothing merges across hats. A merge of two
  People that would join a practitioner account's Person with one of that practitioner's clients is
  refused (it would make them their own client).

### What the business's AI assistant may and may not read
Decision 20: a Care setting, **"Let the assistant read restrictions and rehab exercise lists"**,
off by default, turned on and off only by a person on the staff with `practitioners:manage` (a
`personApproves` setting: the assistant's own request to turn it on waits for a person), and the
screen says the prompts go to the business's model provider.

| Data | The assistant, MCP clients, automations' AI steps | With the setting on |
| --- | --- | --- |
| Restrictions and coach notes | no | yes, when acting for a person on the staff (to keep a drafted program clear of them) |
| Rehab exercise lists | no | yes, the list of exercises only: no notes, and not the client's logs |
| Care links (who sees a practitioner) | no | no |
| Rehab sessions and logs (how the client is going) | no | no |
| Nutrition plans, habits, practitioner notes | **never** | **never** |
| Anything, through SQL, dashboards, search, summaries, embeddings, memory or the digest | **never** | **never** |
Practitioners have no assistant. A customer's own AI client reaches only customer tools, as today.
Errors and logs never carry an authored row's values (the field name only).

### Erasure, merge, the Trash, and people leaving
- **Erasing a client** deletes their care links, consents, shares, and every personal authored row
  about them (assignments, sessions, logs, restrictions, nutrition plans, practitioner notes and
  their versions), not scrubbed and kept as Programs keeps a staff assignment (ADR 0448): health
  rows go. A practitioner's program (no client) stays. Audit rows stay with no values. The
  practitioner is told a client's records were removed. Erase reaches every store (ADR 0320).
- **Erasing a practitioner's Person** ends and deletes their account's sessions; the account row
  stays as `ended` with its name replaced by "a former practitioner", so authored rows keep an
  author and the clients keep their work.
- **Merging two clients** re-points links, consents, shares and personal authored rows to the
  survivor; a duplicate live link with the same practitioner is ended (`merged: a duplicate`); a
  merge touching a live care link is a person's act (an AI asks, a person approves), as for the
  family link; the merge preview counts the care links without showing anything authored.
- **The Trash**: a client in the Trash gives nothing through any link; restored, the links give
  again. A practitioner removing their own record sends it to a Trash only they see (it is not in
  staff's Trash list), purged on the usual schedule.
- **A practitioner leaving**: staff end the account (`practitioner.end`), or the practitioner asks.
  Sessions end at once, every link ends, clients are told, the work stays the clients' (as
  "[name], no longer linked"). A client may share it with another practitioner.
- **A client ending consent**: as above, at once; restrictions as decision 18 says, notes as
  decision 19 says.
- **A consent given by a guardian** (decision 22): ending the family link does not end the care
  link (the child still sees the practitioner); the guardian can no longer reach it. Erasing the
  child erases it as for any client.

### Screens
| Where | Who | What |
| --- | --- | --- |
| Web: Practice home | Practitioner | Clients (live and waiting), ask a new client, notices; nothing else of the business |
| Web: A client | Practitioner | Their programs and sessions with what was done, the nutrition plan, restrictions and notes, and what the client shares from others (marked read only) |
| Web: Builder | Practitioner | Programs' builder block in practitioner mode (rehab and habits kinds, the practitioner's bank entries, notes confidential), publish without approval |
| Web: Nutrition plan, restrictions | Practitioner | Edit and publish a plan; add and lift restrictions |
| Web and native: Consent | Client, or a guardian for a dependant with no sign-in | The request, the filled consent text, agree or decline (a guardian chooses which dependant) |
| Web and native: My practitioners | Client | Who is linked, since when, sharing between them (a colleague included), end; ending lists the practitioner's active restrictions with "remove" on each (decision 18) |
| Native and web: Today | Client | Rehab and habit sessions beside training, marked "from [practitioner]"; log and tick as for training |
| Native and web: My plan, my restrictions | Client | The published nutrition plan; active restrictions, and "remove" on one whose link has ended |
| Web: the hat switch | Anyone with more than one account | Which hat this screen is for; switch, or sign in as another (decision 16) |
| Host admin: Settings, Practitioners | Staff with `practitioners:manage` | Invite, list, end; the consent text's additions; who is told about restrictions; the AI setting (decision 20); export a practitioner's own notes about a client to that practitioner or practice, and remove notes on the client's request or after the practice's retention period (decision 19) |
| Host admin: Person page, Care tab | Staff (a person) | Linked practitioners, active and past restrictions, rehab exercise lists and how the client is going, set by set (decision 17) |
| Coach's client view and builder (Programs' blocks) | Staff | A restrictions banner and the builder's warnings from `restrictionsFor` |
| Class list (Bookings' blocks, the coach) | Staff, the coach role | A flag beside each member with a current restriction; opening it shows them (decision 23) |
Practitioners have no native screens in this stage; the web app works on a phone's browser. No
block decides who sees what: the lint (stage 24) passes for every one.

## Privacy and where the data is kept
In plain words. **This is not legal advice**; the business and the practice should get their own.

- **What the law asks, as the coordinator read it on 2026-11-23.** Australia's privacy law treats
  health information as sensitive. It does not require it to stay in Australia. It asks for consent
  before collecting it, to say if it is stored overseas, to protect it with reasonable security, to
  let people see it, and to delete or de-identify it when it is no longer needed.
- **Where Cloudflare keeps it.** Cloudflare's databases (D1), file stores (R2) and Durable Objects
  accept an **Oceania location hint** (`oc`). It is best effort: Cloudflare does not guarantee it,
  and there is no Australian jurisdiction. Hard jurisdictions exist only for the EU, the US and US
  FedRAMP, per Cloudflare's documentation as read on 2026-11-23. A D1 or R2 hint applies only when
  the store is created. KV and Vectorize take no hint. Where backups, Time Travel, read replicas
  and logs are kept is not verified.
- **What the platform does**:
  - **New installs prefer Oceania** (decision 24; built in step 1, ADR 0580): `cos install
    --location oc`, the installer's question on a first install (default none), or `location: "oc"`
    in a client's `product.ts`, which `cos deploy` passes. The hint is sent only when the D1
    database (`primary_location_hint`) and the R2 buckets (`locationHint`) are created; it is kept
    in the deployment state and shown by `cos status`. Durable Objects take their hint in code,
    object by object; the host passes none (not done, ADR 0580), so Cloudflare places each near its
    first request. **Existing installs are not moved**: `cos install`, `cos deploy` and `cos
    upgrade` say so when asked for another location; moving one is an export and import, not part
    of this stage. `docs/deploying.md` ("Where data is stored") says it in plain words.
  - Consent is **asked and recorded** with the words shown, and the text **says the data may be
    stored overseas** and where to read the business's privacy policy.
  - Practitioner work is kept **out of SQL, dashboards, exports, search, embeddings, summaries and
    AI prompts and logs**, unless a person on the staff knowingly turns on the AI setting (decision
    20) for restrictions and exercise lists; never for notes, plans or habits.
  - Audit rows of practitioner work hold field names, not values. Errors carry no values.
  - **Erase covers it**: every authored row about the client, links, consents and shares.
  - Access is the minimum each hat needs, enforced in the host.
- **What the platform does not promise**: that data stays in Australia; that a model provider the
  business chose, if the AI setting (decision 20) is on, is in Australia; that the business's or the
  practice's own processes (privacy policy, access requests, how long a practice must keep its
  records) meet the law. The practice's own copy of its practitioner's notes is in this stage
  (`care.notesExport`, decision 19); an export of a client's notes to the client, for an access
  request, is left for later.

## Out of scope
- Who pays (decision 13), and anything priced or billed for practitioners.
- A practitioner's own assistant, MCP access or native app.
- A client sharing their gym training, bookings or memberships with a practitioner (decision 8).
- Messaging between practitioner, coach and client.
- Clinical records beyond notes (assessments, measurements, files, referrals, letters), and
  integration with a practice's own system.
- An export of a client's practitioner notes to the client, for an access request (the practice's
  own copy is in scope, decision 19).
- Practitioners booking appointments (stage 31b is staff booking).
- Moving an existing install to another location; a Cloudflare jurisdiction (`eu`, `us`,
  `fedramp`; there is no Australian one); a location hint for Durable Objects, KV, queues or
  Vectorize (ADR 0580).

## Acceptance criteria
1. **The audience**: `practitioner` is a fourth audience; no operation opens to it unless it lists
   it, and every one that does is in `open-operations.json`; a practitioner's call is never queued.
   A practitioner account walked through every operation in the registry, with empty input and with
   real input, is refused every one this stage does not open (`forbidden` or `unknown_operation`),
   in the shape of ADR 0436's door-role walk.
2. **Accounts**: only a person with `practitioners:manage` invites or ends a practitioner (refused to
   the assistant, MCP, automations, extensions and imports); sign-in by code works on the web; ending
   the account ends its sessions at once; one address holds a staff, a customer and a practitioner
   account, each signed in alone, and no session of one resolves to another; the web app shows
   which hat each screen is for and switches between the hats signed in (decision 16).
3. **Consent**: a request shows the practitioner nothing about the address (the same answer and
   timing for a member, an unknown address, a former client, a Person in the Trash and the
   practitioner's own); no Person is created until the client signs in; nothing of the client is
   readable until `me.care.consent`; the consent row holds the version and hash of the words shown,
   the words as shown, who accepted for whom, the account and the channel, and is never edited (the
   shape stage 44 can take over); declining, withdrawing and expiry look the same to the
   practitioner; a consent to one practitioner gives their colleague at the same practice nothing
   (decision 21).
3a. **A child** (decision 22): a guardian with a live family link agrees for a dependant with no
   sign-in of their own, and the consent records both; a guardian cannot agree for a dependant who
   has their own sign-in, nor for a Person they are not linked to (answered as `not_found`); the
   guardian reads the child's care records as the child would and may end the link; once the family
   link ends the guardian reaches none of it.
4. **Isolation** (stage 22's suite extended, over `invoke` and over HTTP, with two practitioners, a
   shared and an unshared client, a member who is nobody's client, and a requested link): a
   practitioner cannot read or write a non-linked Person, an un-consented one, another
   practitioner's work (unless the client shares it, then read only and never their notes), the
   business's own programs and logs, memberships, passes, bookings, orders, payments or
   subscriptions, by any operation, by naming ids (answered as ids that do not exist), through
   `my.*`, Programs' tools or the Care tools.
5. **Ending is immediate**: after `me.care.end`, the practitioner's next read finds nothing; a write
   racing the end fails in its own batch (the guard), as the family link's does; the client keeps
   their rehab, plan, restrictions and logs. Restrictions (decision 18): those the client removes as
   they end it stop showing to coaches in the same batch; the rest stay visible to coaches until
   their end date, and the client can remove one later. Notes (decision 19): after the end nobody
   reads them in the product (the practitioner, staff, the client, a shared practitioner, an AI
   actor).
   - `care.notesExport` is made only by a person with `practitioners:manage`. It is refused to the
     assistant, MCP, automations, extensions and imports, and an AI's request to make it is refused
     too.
   - The export holds only that practitioner's own notes about that client: nothing else of the
     client's, and no other practitioner's work.
   - It reaches only that practitioner or their practice, as an expiring one-time download. It is
     never shown in the admin.
   - It is audited without values.
   - Erasing the client deletes the notes.
   - `care.notesRemove` is a person's act, with a basis of `client` or `retention-ended`, and is
     refused for anything else.
3b. **A minor** (decision 22 with stage 44): when stage 44's "is a minor" mark is set on a Person,
   the Person's own `me.care.consent` is refused. Only a linked guardian, or staff recording a paper
   form, gives the consent, as stage 44's rule says.
6. **Authored rows and staff**: with a fixture of practitioner work, every staff path (record list
   and get, search, `query.sql`, every dashboard, exports, summaries, embeddings, the digest, the
   Trash list, the timeline, audit values, notifications' email bodies, MCP and the assistant) shows
   none of it, except, to a person on the staff, on screen: restrictions, and rehab programs and
   sessions with no notes and their logs, set by set (decision 17); never a nutrition plan, a
   habits program or a practitioner note. Staff writes to authored rows are refused for every actor.
7. **AI** (decision 20): the assistant and an MCP client acting for an admin read none of it; the
   setting is off on a new host; with it turned on by a person (the assistant's own request to turn
   it on waits for a person), they read restrictions and rehab exercise lists only (not logs, not
   care links); notes, plans and habits never.
8. **Three hats**: one person with a staff account (coach), a customer account (member) and a
   practitioner account (dietitian), and a client for whom they are both dietitian and coach, with a
   physiotherapist on the same client:
   - the staff account's answers for that client equal another coach's account's, call for call;
   - the staff account cannot read the dietitian's nutrition plan, habits or notes, nor the
     physiotherapist's notes, and cannot change any of them;
   - the practitioner account reads only its own work for its live clients and nothing of the
     business, whatever the same person's staff role or grants;
   - the customer account reads only that person's own records;
   - a care link from the practitioner account to its own Person is refused, and so is a merge that
     would make one;
   - a staff pack role or grant added to the staff account (issue #258) changes nothing the
     practitioner or customer account may do.
9. **Programs**: a practitioner builds a rehab program and a habits program in the builder, assigns
   them to a live client without a coach's approval, and the client logs sets, ticks habits and
   records an amount in the native and web blocks the way they log training; the practitioner sees
   what was done; the session plan the coach sees has no notes.
10. **Care pack**: restrictions are added, lifted and expire on their date; coaches are told in the
    host with the text and by email without it; `restrictionsFor` names the exercises in a program
    a restriction touches; a nutrition plan's working copy is unseen by the client until published.
10a. **The class list** (decision 23): a coach's class list shows a flag beside each member with a
    current staff-visible restriction and none beside anyone else; the flag opens to those
    restrictions; it names nothing of notes, plans or habits; a restriction the client removed or
    that expired gives no flag.
11. **Sharing**: only the client starts and ends a share; it is one way and read only; it stops when
    either link ends or the client ends it; sharing with a colleague at the same practice works as
    with any practitioner (decision 21).
12. **Erase and merge**: erasing a client deletes every authored row about them and their links,
    consents and shares; merging two clients follows the rules above and waits for a person when a
    live care link is touched; erasing a practitioner's Person leaves their clients' work.
13. **Location** (decision 24; built in step 1, ADR 0580): a new install asked for Oceania (`cos
    install --location oc`, or `location: "oc"` in `product.ts` for `cos deploy`) creates its D1
    database with `primary_location_hint: "oc"` and its R2 buckets with `locationHint: "oc"`
    (proved against the fake Cloudflare API, which records each create and refuses a value the real
    API would); one not asked sends no hint; a repair or an upgrade sends none to a store that
    exists, and says plainly that an existing install is not moved; KV, queues and Vectorize are
    sent none.
14. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/care` and
    `packs/programs`, the block lint, and one e2e test per journey (a client agrees to a request; a
    physiotherapist assigns a rehab program and the client logs it; a coach sees a restriction and
    no notes; a client ends consent and removes a restriction; a guardian agrees for a child) pass
    in CI. ADRs for each platform piece; `CONTEXT.md` and
    `docs/architecture.md` updated.

## Dependencies
- Stages 22, 23, 24 and 41 (merged); stage 31 step 6's family link (merged) as the pattern.
- Nothing from 31b, 32b or 33. Stage 14a, when it comes, extends the same seam (staff scopes) and
  must keep authored rows out of staff's bulk paths.

## Migrations and numbers
Block **AR** in [`parallel-work.md`](../parallel-work.md) (migrations 0730–0749, ADRs 0580–0589),
claimed by step 1, which used ADR 0580 and no migration. The later steps take theirs from it (or
the next free block if it runs out): migrations for `core_practitioner` and its sessions, `core_care_link`, `core_care_share`,
`core_care_link_guard`, the consent texts, the permission, and the reconciler's second view; no
`x_*` table is touched by a migration. ADRs the build will need (not written until built):
1. The practitioner principal and audience, the account, invites and sign-in.
2. The care link: requests, consent, ending, sharing, the guard.
3. Authored rows: the stamp, the split views, staff's on-screen part, staff cannot write, AI actors.
4. Confidential document parts.
5. One person, several hats: accounts never combine across principals (and how this sits with
   issue #258's roles that add up within one).
6. The Care pack and Programs' additions.
7. The location hint on new installs: **written**, [ADR 0580](../adr/0580-a-location-hint-on-new-installs.md).
ADR 0402 (a fourth principal), 0414 (tools run as a practitioner), 0436, 0445, 0448 and 0540 are
amended with dated notes.

## Suggested build order
| Step | What | Platform files it touches | Runs beside stage 31/32 work? |
| --- | --- | --- | --- |
| 1 | **The location hint** for new installs. **Built** (ADR 0580): D1 and R2 on create; Durable Objects not done | `packages/release/src/cloudflare.ts`, `deploy.ts`, `install.ts`, `update.ts`, the fake Cloudflare; `packages/product` (`location`); `packages/create-composable-os` (`--location`, the question, `cos deploy`, `cos status`), deployment state | **Yes, now.** Touches nothing 31 or 32 touch |
| 2 | **Programs' additions**: kinds `rehab` and `habits`, `check` and `amount` measures, sets and log fields, `confidential` marks on layout notes (inert until step 5) | `packs/programs` (`index.ts`, `layout.ts`, tools), its blocks; the SDK's document node type | **Yes, now**, but agree with the owner of PR #256 (31a step 9) if it touches `packs/programs` (`classToday`, the Person tab) |
| 3 | **The principal, audience, accounts, invites and sign-in** | `principals.ts`, `audiences.ts`, `pipeline.ts`, `invoke.ts`, `open-operations.json`, `packages/auth`, `apps/app/src/server/http/` (auth routes), `packages/client*` (a practitioner client), a migration | After PR #256 merges if it changes the HTTP surface or sign-in mail; otherwise yes. Its own session, reviewed as stage 22 was |
| 4 | **The care link and consent**, sharing, the guard, the consent page, Trash, merge and erase of links | `visibility/` (new `practitioners.ts`), `operations/` (new `care.ts`, `me.ts`), `person.merge`, `person.erase`, `records/erase.ts`, a migration | **Not beside other seam or erase/merge work.** After step 3 |
| 5 | **The practitioner scope and authored rows**: the stamp, the split views, staff's on-screen part, staff writes refused, AI actors, confidential parts, audit without values, search and embeddings skipped; the isolation suite (criteria 4, 6, 7, 8) | `visibility/` (`index.ts`, `writes.ts`, `records.ts`), the reconciler (`extensions/schema.ts`), `records/` writes, search, embeddings, summaries, audit, `operations/query.ts` (no change expected; proved), the assistant's reads, the SDK contract | **Its own window.** Touches every read path, like 14a: nothing else in the seam at the same time |
| 6 | **The Care pack**: restriction, nutrition plan, note, tools, `notify`, the Person page's Care tab, `restrictionsFor` | `packs/care` (new), host notifications (`notify`), the Person page tabs in `apps/app` | Yes, beside 31/32 pack work, once step 5 is merged |
| 7 | **Blocks and hooks**: practice home and client page, the builder's practitioner mode, the nutrition plan and restrictions editors (web); consent, my practitioners, Today, my plan (native and web) | `packs/care/blocks`, `packs/programs/blocks`, the client template's routes | Yes |
| 8 | **The first client**: invite the practice, the consent text's additions, a real client's journey | The first client's own repository | After 7 |

**The spine is steps 3 to 5**: without the principal, the link and the scope nothing can be seen
safely. Steps 1 and 2 can start today. Step 5 is the riskiest and gets the most careful review.

## Decided by this spec, open to override
- **A fourth principal and audience**, not a staff pack role or a customer with links (above).
- **No Person is created by a practitioner.** A client's Person comes from their own first sign-in,
  or is the member's existing record.
- **Practitioners use and add to the business's exercise bank**; their entries are visible like any
  and marked with their author. An exercise names a movement, not a person.
- **A practitioner's program has no client** and can be given to several of their clients; its
  assignments, sessions and logs are the personal rows.
- **A practitioner's private notes are never shared**, not even when the client shares the rest.
- **Disciplines are labels.** Any practitioner may add any kind of work; nothing is limited by
  discipline, so another practice can be added without changing the platform.
- **Practitioners work on the web only** in this stage.
- **Staff see restrictions on screen and receive them in the host's notices; email carries no content.**
- **Requests expire after 30 days and are limited to 20 a day per practitioner** (guesses).
- **How the owner's answers are read where they leave a detail open** (2026-11-23):
  - decision 18: a restriction with **no end date** stays for coaches until the client removes it
    (the practitioner can no longer lift it once the link has ended);
  - decision 19: "until the practice asks for them" means **the practice asks for its own records
    to be handed over** (the recommendation the owner accepted: a practice may have to keep its
    clinical records for years). It is an export of that practitioner's own notes, not deletion
    (corrected 2026-11-23). Removal outside erasure happens only on the client's request, which the
    business handles, or the practice's after its retention period. Handing notes to the client
    (an access request) stays out of scope;
  - decision 22: a dependant **with** a sign-in of their own agrees themselves (as option (a)
    said), unless stage 44's "is a minor" mark is set on their Person: then a guardian or paper, as
    stage 44 says. The guardian who agreed may end it;
  - decision 23: "only those the client agreed to share" is read as **restrictions under a consent
    the client gave** (whose text says coaches see restrictions), with no per-restriction choice;
    the flag is the mark, and its restrictions open from it (the title is not printed on the list);
  - decision 20: the rehab exercise list given to an AI actor is the list of exercises, without the
    client's logs (decision 17 is for coaches, who are people).

## Questions for the owner
None open. The seven questions of the proposal were answered on 2026-11-23: decisions 17 to 23
(question 1 is decision 17, question 7 is decision 23), with decision 16 accepting the three hats
and decision 24 the location hint.

## To confirm with the practice
Before step 8 (the first real client). None of these blocks the build: each is a setting or a line
in the consent text.
- **Keeping notes after consent ends.** The client ended sharing, but the practitioner still has a
  duty to keep records. Confirm that the practice wants the notes kept, closed, in the host, and
  how it wants its copy: to the practitioner's address, or to the practice's (`care.notesExport`).
  Confirm how long it must keep them, so that a later `care.notesRemove` on `retention-ended` is
  well founded.
- Whether the client is told when the practice is given a copy of the notes.
- Erasing a client deletes the notes. Confirm whether the business should offer the practice its
  copy before it erases a client who has a practitioner's notes.
- What the practice does when a client asks the business to remove their notes before the
  retention period ends (removal on `client`, or the export first).
- The words the consent text uses for this, so the client knows before agreeing.

## Sources
Read 2026-11-23, all in this repository: `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
`docs/roadmap.md`, stages 31 and 41; ADRs 0402, 0410 to 0414, 0436, 0445, 0448, 0455, 0540, 0552;
issue #258; `packages/core/src/principals.ts`, `audiences.ts`, `pack-role-today.ts`,
`visibility/index.ts`, `visibility/guardians.ts`, `visibility/writes.ts`, `operations/query.ts`
(the validator's header); `packages/db/migrations/0401_customer_accounts.sql`, `0490_staff_invites.sql`;
`packages/release/src/cloudflare.ts` and `deploy.ts` (no location hint). The privacy law is as the
coordinator read it on 2026-11-23, not checked again here. Cloudflare's location controls were
read again for step 1 on 2026-11-23 and are cited in ADR 0580: D1's and R2's data location pages
and create APIs, Durable Objects' data location page, and the KV, Queues and Vectorize create APIs.

Not confirmed, and checked at build: whether the reconciler can give one object two views cheaply;
whether the record code reads any `x_*` table outside the seam (each such read must leave authored
rows out); how a third sign-in sits with Better Auth. Checked in step 1: Durable Objects take a hint
in code at each object's first `get()`, not at deploy; the host passes none (ADR 0580).
