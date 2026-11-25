# ADR 0581: The practitioner principal, its accounts, invites and sign-in

Status: accepted, 2026-11-25 (stage 43, build step 3, `feat/stage-43-practitioner-principal`).
Amends [ADR 0402](0402-staff-and-customers.md) (a fourth kind of caller). Builds on ADRs
[0411](0411-audiences-on-operations-as-built.md) (audiences),
[0413](0413-outside-handlers-have-no-raw-database.md) (outside handlers),
[0419](0419-native-sessions-and-customer-sign-in.md) and
[0455](0455-staff-invites-and-native-sign-in-by-tokens.md) (sign-in by code, invites), and
[0421](0421-the-client-app-binding-and-customer-sign-in.md) (the client-app binding). Stage 43's
spec, "Platform: the principal, the account and sign-in", decisions 2, 15 and 16.

## Context
A business invites outside practitioners (a physiotherapist, a dietitian) to work with its clients
on its own host. The spec rejects a staff pack role (staff read every row) and a customer with
links (a customer is the subject of their records) and asks for a fourth caller, with its own
account and sign-in, that can reach nothing until a client agrees. One human may be a
practitioner, a coach and a member at once (decision 15), with three sign-ins and nothing joining
them (decision 16). Steps 4 and 5 add the care link and the practitioner scope; this step adds
only the caller, so that on the day it ships a practitioner can be invited, sign in, and reach
nothing about anyone.

## Decision

### The principal and the audience
- **`PractitionerPrincipal`**: `{ kind: "practitioner", practitionerId, personId }`
  (`principals.ts`); it is one of the `OutsidePrincipal`s, beside customer and public. A fourth
  audience, `practitioner` (`audiences.ts`). `audienceOf` stays `principal.kind`: a caller has
  exactly one audience.
- **No existing operation lists it.** Opening one to practitioners is a reviewed change, listed in
  `open-operations.json`, with the risk floor (`read`, `write`) the customers' have. This step
  opens one: `practitioner.me` (read, `hostInternal`: the caller's own account row, read by the
  principal's id). A test walks every operation in the registry and the carried packs' tools as a
  practitioner, with empty input and with real ids, and reaches that one alone.
- **The pipeline**: a practitioner's call takes the outside path (`invokeOutside`): no role, no
  queue (applied or refused, under any preset or floor), no staff user, no raw database or write
  queue unless `hostInternal`, a write check at the seam (which refuses any record change by a
  practitioner: "This call cannot change records"), rate limited per account and operation
  (`practitioner:<id>:<operation>`), audited with the outside actor **`practitioner`** and the
  account's id. `{ $relative: "me" }` names no one for them: their own Person is never a client.
  A principal value is read for its kind, `practitionerId` and `personId` only. Their idempotency
  keys are scoped to their account. A routine-mail mark of a practitioner's write takes the
  public's standing, the weakest.
- **The seam: the empty scope.** `scopeOf` answers `none` for a practitioner on every object,
  explicitly (not by falling to the default), so no object exists for them, not even one the
  public may read. Step 5 puts the practitioner scope in that one place.
- **No pack's tool opens to them.** The SDK's tool audiences (`TOOL_AUDIENCES`) do not name
  `practitioner`, so no manifest can declare one; the tool starter refuses a practitioner too.
  Step 5 extends the SDK with the `practitioner` declaration.
- A practitioner places no order (`placedAs` throws), as a device places none.

### The account
- **`core_practitioner`** (migration 0730): `prc_…`; the practitioner's own Person (their name and
  contact, as staff see them; one account per Person); the sign-in address (one account per
  address); the invite's name; discipline (a label); practice (an Organisation, optional); status
  `invited` → `active` (at the first sign-in) → `ended`; who invited them and when; when it
  became active; who ended it, when and why; the last sign-in. Never a `core_user`, never a
  `core_customer`.
- **`practitioner.invite { email, name, discipline, practiceId? }`**, **`practitioner.end { id,
  reason }`**, **`practitioner.list { status? }`**, **`practitioner.get { id }`**: staff audience,
  `actors: ["human"]`, not on MCP, and refused from a device session (`staffDevice`: the company's
  app on a phone and the import door are a person's but not the web admin's). A new permission,
  **`practitioners:manage`**: admins by default, grantable one by one (ADR 0449), not restricted.
  So the assistant, MCP, automations, extensions and an import cannot invite, list or end a
  practitioner, whatever is granted.
- **The Person**: the one live Person with the address (the same-email rule, ADR 0247), or a new
  one the inviter makes in the same batch through `person.create` with the address and name.
  Several People with the address: refused, merge them first. An erased person's address: refused
  as any unusable address is. A Person who already has a practitioner account: refused.
- Inviting an address whose account is still `invited` updates it and sends the notice again; an
  `active` or `ended` account's address is refused (`conflict`). Bringing an ended account back
  is not in this step.
- **Ending** sets `ended` and, in the same batch, deletes every session of the account and its
  unused codes; a session left anyway resolves to no one, because the account is read at every
  request and never cached.
- **The invite notice** names the business, who invited them and what the account is for, holds no
  secret (the code that accepts it goes only to the address), and says where to sign in (the
  business's web app, `CUSTOMER_AUTH_URL`, when set). It is the host's ordinary mail (ADR 0455's
  invite notice), so it may wait for review.
- **Merge**: the duplicate's account moves to the survivor; a merge of two People who both have one
  is refused (`practitioner_accounts`). The care-link rules of a merge are step 4's.
- **Erase**: erasing the Person deletes the account and its sessions (the foreign key, as for a
  customer account). Step 5, when authored rows exist, keeps the row as "a former practitioner".

### Sign-in
- **A third Better Auth configuration** (`packages/auth/src/practitioner-auth.ts`), apart from the
  staff and customer ones: its own tables (`core_practitioner` as the user model,
  `core_practitioner_session`, `core_practitioner_verification`), its own cookie
  (`cos-practitioner.*`) and its own key. Sign-in by an emailed code only (six digits, five
  minutes, three tries, stored hashed); sign-up is off (`disableSignUp`, and the user create hook
  refuses), so an account is made only by an invite. A code goes only to an `invited` or `active`
  account's address; any other address (unknown, ended, a customer's or staff member's only) gets
  the same answer and nothing is sent or kept. A wrong code answers one way (ADR 0455). No client
  address is stored. Limits: the customer bindings, per address asked for and per client address.
- **Its key** is HMAC-SHA256 of a fixed label under `CUSTOMER_AUTH_SECRET`
  (`practitionerSessionSecret`): env-only, no new secret to provision, and a key that verifies
  neither a staff nor a customer cookie. Without `CUSTOMER_AUTH_SECRET`, or when it equals the
  staff secret, practitioner sign-in fails closed, as customer sign-in does.
- **The routes**: `/api/practitioner-auth/email-otp/send-verification-otp`, `/sign-in/email-otp`,
  `/get-session` and `/sign-out`, on the host and over the client-app binding (the business's web
  app forwards the practitioner's `cos-practitioner.*` cookie as it forwards a customer's; the
  runtime's helper for it, beside `customerSession`, comes with the web app's practitioner
  screens in step 7). Codes go out as the host's sign-in mail, on the staff code's fixed
  template (the gatekeeper gives the sign-in kind to that template only; its words name no hat).
- **One call, one hat.** A request carrying two kinds of session (staff and customer, staff and
  practitioner, customer and practitioner) is refused, on the HTTP surface and over the binding.
  A practitioner's session is never exchanged for app tokens (`/api/v1/auth/token` refuses it).
- **Three hats**: one address may hold a staff, a customer and a practitioner account at once; each
  is signed in on its own and its session resolves to its own principal only. Nothing in the host
  reads one account when deciding what another may do.
- **The typed client** gains a third entry point, `practitioner.ts` (`createPractitionerClient`),
  holding only what practitioners may call; `api/v1/practitioner.json` is its committed contract.

## Not in this step, and why
- **The native token routes** the spec names (`/api/v1/auth/practitioner/code` and `/sign-in`,
  ADR 0455's shape). Those routes answer with a device session's tokens, and
  `core_device_session` holds only staff and customer sessions (a CHECK on `audience`); adding a
  third means rebuilding that table, which `core_person_code` references with `ON DELETE
  CASCADE`, so the rebuild would delete those rows. Practitioners work on the web only in this
  stage and the web app signs in with a cookie, over the binding, which never serves the token
  routes (ADR 0421). The cookie routes above are the same code, limits and answers. A native app
  for practitioners adds the token routes with that rebuild.
- **The hat switch** in the web app (decision 16) is a screen: stage 43's blocks (step 7). The
  host gives what it needs: each session resolves to one hat, `practitioner.me` says which, and a
  request with two is refused.
- **The admin screen** (Settings, Practitioners) is step 7's too; the operations are here.
- The care link, consent and the practitioner scope (steps 4 and 5).

## Consequences
- A fourth caller exists that reaches nothing: proved by the registry walk, the seam's empty
  scope on every object (a test fails if the scope is the staff one or the public's), and over
  HTTP (every operation but `practitioner.me` answers as one that does not exist, the manifest
  names that one alone).
- Steps 4 and 5 open operations to the audience one by one, each a line in
  `open-operations.json`, and give the scope in `visibility/` only.
