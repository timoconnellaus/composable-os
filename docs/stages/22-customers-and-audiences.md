# Stage 22: Customers and audiences

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Audiences and customers, Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md), ADR
[0402](../adr/0402-staff-and-customers.md), `docs/stages/14-teams-permissions.md`, ADRs 0003,
0008, 0018, 0019, 0023, 0025, 0090, 0244, 0245, 0247, 0320, and
`packages/core/src/principals.ts`, `pipeline.ts`, `invoke.ts`, `gate.ts`, `list.ts`,
`rate-limit.ts`, `records/`.

Status: **spec agreed** (interview 2026-11-20). Builds on stage 20. This stage changes what the
host exposes to people outside the org. It is reviewed with the most care of any stage here.

## Goal

A person who is not staff can have an account. Signed in, they can read and change their own
records and nothing else: not another customer's records, not staff notes on their own record, not
the admin, the MCP surface or any SQL. A visitor with no account can call the few operations marked
public. Every existing operation stays staff-only until someone opens it on purpose, and opening
one shows up in review.

## What exists today (from the code)

- **Roles:** `admin`, `member`, `viewer` (`ROLES` in `packages/core/src/principals.ts`), in
  `core_user.role`. `core_user` is Better Auth's own table. Permissions are object-agnostic
  (`records:read`, `records:write`, …).
- **Actors:** `human`, `assistant`, `mcp`, `automation`, `extension`; system jobs run as a system
  user.
- **One pipeline:** `invoke()` validates, gates, checks the role, runs the handler and writes one
  D1 batch with the audit row.
- **Read paths each name their own source:** `runListQuery`, `record.count`, `record.groups`,
  `export.csv`, `loadRecord`, `loadPerson`, `loadDisplays`.
- **The visibility seam** (ADR 0244) is designed and not built. It has three doors: one filtered
  source every read takes (`visibleSource`), a rewrite of user SQL, and hydration of search hits.
  It was designed for staff scopes (own, own team) and has no field-level rules.
- **A precedent:** private activities are filtered in the base views, search, embeddings and
  summaries.
- **No customer exists.** Every signed-in user is staff. There is no public operation; inbound
  webhooks arrive through a gatekeeper, not an operation.
- **Risk classes:** `read`, `write`, `bulk-write`, `destructive`, `schema`, `extension`,
  `outbound`.

## Decided at the interview (2026-11-20)

| Question | Decision |
| --- | --- |
| The visibility seam | **Build its first door here** (`visibleSource`), to ADR 0244's design. Stage 14a adds staff scopes, the SQL rewrite and search hydration later, on the same seam |
| Sign-in | A one-time code by email. Nothing else for now |
| Who can sign up | A setting per product: open, or invite only |
| First sign-in | One matching Person: link. None: create. Several: do not link, and tell staff to merge |
| What a customer sees | Nothing unless the object lists it, field by field |
| Reads and writes | Generic reads (`my.list`, `my.get`) through the seam. Writes only through tools a pack opens |
| Staff who are also customers | Two separate accounts. Never one session with both |
| Approval | Customer calls are never queued. The host allows or refuses |
| Deleting an account | Disabled and signed out at once; an erase request for staff to action within a set time |
| Runtime extensions | **Cannot** open a tool to customers or the public. Only shipped extensions and the org's own reviewed ones can |
| The public audience | Built now, with no operation using it |
| Left out | A customer-visible timeline; acting for someone else; staff previewing as a customer; passkeys and social sign-in |

## Scope

### The seam's first door
- `packages/core/src/visibility/` gets `visibleSource(ctx, object)`: the object's `rec_*` view,
  filtered for the caller. Every read path listed above takes its source from it.
- For staff the scope is `all` and nothing is filtered, so staff reads cost and return exactly what
  they do today. Staff policies, teams and the other two doors are stage 14a's.
- For a customer the scope is "rows whose customer field is my Person", limited to the fields the
  object lists.
- A test fails when a `rec_*` view or a core record table is read outside the seam, as ADR 0244
  specifies, so it stays the only place.

### Audiences on operations
- An operation definition gains `audiences`, a non-empty subset of `staff`, `customer`, `public`.
  Left out, it is `["staff"]`.
- `invoke()` refuses a call whose principal's audience is not listed, before validation, with one
  error that does not say whether the operation exists.
- Operations open to `customer` or `public` may have risk class `read` or `write` only. The
  registry refuses to load one with any higher class.
- A generated file lists every operation open to `customer` or `public`, with its risk class. It
  is committed, and CI fails when the registry and the file differ. Opening an operation is then
  always a visible line in a diff.
- `defineTool` in the SDK gains the same key for shipped extensions and an org's own. A runtime
  extension that declares any audience but `staff` fails `check` with a message.

### Customer accounts
- A **customer account** links to exactly one `core_person`. Tables are `core_customer` and its
  sessions, separate from `core_user`.
- Customer sign-in runs as a second Better Auth configuration with its own tables, cookie name and
  secret. A customer session cannot be read as a staff session by any code path, because it is
  never in the same table or cookie.
- Sign-in is by a one-time code sent to an email address through the email-send gatekeeper.
- **Sign-up is a product setting,** `open` or `invite only`, changed by a human admin only.
  - Open: anyone who verifies an address gets an account.
  - Invite only: a code is sent only to an address staff have invited (`customer.invite`) or that
    already has an account. Asking for a code for any other address gets the same answer and sends
    nothing, so the form cannot be used to find out who is a customer.
- At first sign-in the verified address is matched to a Person by the existing "same email" rule.
  One match links; none creates a Person; several link nothing, tell the person their account
  needs a moment, and notify staff, who merge first. The erased-address list is checked, as
  `sync.ingest` does.
- The principal is `{ kind: "customer", customerId, personId }`, and the audit actor is `customer`.
  A public call has principal `{ kind: "public" }`.
- A staff member who is also a customer has two accounts. Nothing links them.

### What a customer can see: the `customer` key
- An object declares its customer and, field by field, what the customer may read and write:
  `customer: { field: "buyer", read: ["status", "total"], write: [] }`. Fields not listed are
  invisible to customers. Nothing is visible by default.
- The base records declare theirs in core: a Person is its own customer, with a short list of
  readable and writable fields (name, email, phone). Organisations, Activities and Tasks declare
  none in this stage.
- Through the seam, every read by a customer is limited to their rows and the declared fields.
  Writes are checked the same way, and may set the customer field only to themselves.
- An operation handler never filters by customer itself.

### Operations opened in this stage
- `me.get`, `me.update`: the customer's own Person, declared fields only.
- `my.list { object, filter?, sort?, cursor? }`, `my.get { object, id }`: generic reads of any
  object that declares a customer.
- `me.signOut`, `me.sessions.list`, `me.sessions.revoke`.
- `me.deleteAccount`: see below.
- For staff (`users:manage`, human only): `customer.list`, `customer.invite`, `customer.disable`,
  `customer.enable`, `customer.revokeSessions`. A Person's page shows whether they have an account
  and when they last signed in.
- No generic customer write. A customer changes extension records only through a tool a pack
  opens to them.
- No public operation ships in this stage. The audience is tested with a fixture operation.

### Deleting an account
- `me.deleteAccount` disables the account and ends every session at once. The person can no longer
  sign in.
- It creates an **erase request** naming the Person, when it was asked and when it is due (a
  product setting, default 30 days). Admins are notified, and open requests show in the admin with
  their due dates.
- Staff either erase the person with the existing erase operation, or decline with a reason (a
  record the org must keep), which is emailed to the person. Both close the request and are
  audited.
- A request past its due date notifies admins daily until it is closed.

### What customers and the public can never reach
The admin UI, `/mcp`, Code Mode, `query.sql`, dashboards, exports, the approval queue, the
assistant, and every operation not in the generated list. A request with a customer session to any
of them gets the same answer as a request with no session.

### Approvals, limits and audit
- A customer's call is never queued for approval. The gate allows or refuses it.
- Customer and public calls are rate limited per account and per operation, and public calls and
  code requests per client address through Cloudflare's rate limiting, with no address stored.
- Customer writes are audited with field diffs like any write. Customer reads are counted, not
  audited row by row, as for non-human readers (ADR 0090).

### Erase and merge
- Erasing a Person deletes their customer account, sessions and any open erase request, and the
  address goes on the erased-address list as now.
- Merging two people moves the account to the survivor. When both have one, the merge is refused
  with a reason until staff disable one.

## Out of scope
- The HTTP surface these calls arrive on (stage 23). This stage is tested through `invoke()`.
- Staff scopes, teams, invites for staff, the SQL rewrite and search hydration (stage 14a).
- Passkeys, social sign-in, passwords.
- A customer acting for someone else (a parent for a child, a coach for a client).
- Staff previewing a client app as a particular customer.
- A timeline customers can see.
- Runtime extensions opening tools to customers or the public.
- Moving Ghetto's existing accounts across (stage 27).

## Acceptance criteria
1. **Default closed:** with this stage merged and nothing else changed, the generated list holds
   only the operations named above, and every other operation refuses a customer and a public
   principal.
2. **Staff unchanged:** every existing read returns the same rows and costs the same `rows_read`
   as before the seam. A test compares them on the seeded data.
3. **One seam:** a read of a `rec_*` view or core record table outside `visibleSource` fails a
   test.
4. **Isolation, generically:** a test builds two customers, A and B, each with records in every
   fixture object that declares a customer, and calls every operation in the generated list as A
   with B's ids, B's filters and guessed ids. No response holds a value from B's rows, and no
   write changes one. The test reads the registry, so a newly opened operation is covered without
   being added by hand.
5. **Fields:** a field not listed in `read` never appears in a customer's response, including in
   filters, sorts, errors and field diffs. Filtering or sorting on one is refused.
6. **Closed surfaces:** a customer session gets the no-session answer from the admin routes,
   `/mcp`, `query.sql`, dashboards and exports.
7. **Sessions apart:** a customer cookie presented as a staff cookie, and the reverse, is refused.
8. **Risk floor:** an operation or tool declared with a higher risk class and a `customer` or
   `public` audience fails at load, with a message.
9. **Runtime extensions:** one that declares a `customer` or `public` audience fails `check`.
10. **Sign-in:** a code links to the one matching Person, creates one when none matches, and links
    nothing when several match, with staff notified; an erased address is refused.
11. **Invite only:** an uninvited address gets the same response as an invited one and no code is
    sent; changing the setting is refused for non-human actors.
12. **Deleting an account:** the account is disabled and its sessions ended in the same batch; an
    erase request exists with its due date; erase and decline both close it; an overdue one
    notifies admins.
13. **Erase and merge** behave as specified, and erase leaves no customer row, session, code or
    request.
14. **Limits:** rate limits hold per account, per operation and on code requests; no client
    address is stored.
15. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Audience, Customer, Public,
    Erase request) and `docs/architecture.md` are updated, and ADR 0244 gets a dated note saying
    its first door was built here.

## Dependencies
- Stage 20.
- **Not** stage 14a. This stage builds the part of the seam it needs, and 14a extends it.

## Migrations and numbers
Migrations 0400 to 0409. ADRs 0410 to 0414, and ADR 0402 amended as built.

## Suggested build order
1. `visibleSource` with only the staff scope, every read path moved onto it, and the
   staff-unchanged and one-seam tests. Nothing behaves differently yet.
2. `audiences` on operations, the refusal in `invoke()`, the risk floor and the generated list.
   Nothing is opened yet.
3. The customer principal and the customer scope on the seam, with the isolation test written
   first against fixture objects.
4. Customer accounts, sign-in and the sign-up setting.
5. `me.*`, `my.*`, the staff operations and the Person page.
6. The `customer` key and `audiences` in the SDK, and the runtime-extension refusal.
7. Deleting an account and erase requests.
8. Erase and merge.

Steps 1 to 3 are the spine: they decide whether a customer can ever see another's data. They are
built and reviewed before anything else is handed out.

## Amendments

### 2026-11-20, after the review of steps 1 to 3
- **Criterion 3 is met by a ratchet.** A read of a record view or table outside the seam fails a
  test unless its file is on the test's list with a count and a reason. The list had 180 reads in
  36 files when it was written, and stage 14a empties it (ADR 0410).
- **A handler called by a customer or the public has no raw database.** It reads and writes
  records through `ctx.records` only. A core operation marked `hostInternal` keeps the database
  for account and session bookkeeping, and the generated list shows the flag (ADR 0413).
- **The generated list is `packages/core/open-operations.json`.** A fixture operation is never
  in it: tests use a registry of their own (ADR 0411).
- **A deploy-time floor that asks for review does not apply to customers or the public.** One
  that denies does.
- **An audience refusal and a failed read by an outside caller write no audit row.**
- **The audit tables no longer constrain the actor.** The pipeline validates it (migration 0400).
- **A pack's tool called by a customer runs as that customer,** and lists per object the fields
  it may set beyond `customer.write` (ADR 0414).
