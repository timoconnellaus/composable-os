# Stage 14: Teams and permissions

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Identity,
Data, Customers and audiences, the visibility seam), [`CONTEXT.md`](../../CONTEXT.md) (Visibility
seam, Scope, Pack role, Grant, Restricted permission, Note level, Looks after, Location),
ADRs [0244](../adr/0244-visibility-enforced-at-one-seam.md) and
[0245](../adr/0245-roles-teams-and-identity-seams.md) (this stage's, both amended 2026-11-25),
[0402](../adr/0402-staff-and-customers.md), [0410](../adr/0410-the-seams-first-door-as-built.md)
(the seam's first door and its ratchet), [0436](../adr/0436-pack-roles-and-the-door-role.md),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md),
[0625](../adr/0625-restricted-pack-permissions.md),
[0755](../adr/0755-the-mine-reach-for-pack-roles.md),
[0889](../adr/0889-a-pack-role-limited-to-the-people-its-holder-looks-after.md) (pack roles, their
grants and their reach), [0811](../adr/0811-restricted-fields.md) (restricted fields),
[0830](../adr/0830-note-levels-kept-out-of-every-bulk-path.md) to
[0832](../adr/0832-the-notes-permissions.md) (note levels, looks after, the notes permissions),
[0540](../adr/0540-the-family-link.md) (the guardian scope),
[0910](../adr/0910-locations-a-base-record-inside-the-one-organisation.md) (locations),
[0246](../adr/0246-leads-as-an-extension-and-assignment-rules-in-core.md) (owners and assignment
rules), [0020](../adr/0020-query-sql-validator-and-csv-import.md),
[0057](../adr/0057-dashboards-params-cache-and-click-through.md), [0153](../adr/0153-ai-summaries.md)
and [0155](../adr/0155-hybrid-search-similar-records-and-retrieval.md); stages
[22](22-customers-and-audiences.md), [43](43-practitioners.md) (step 5, the practitioner scope),
[56](56-client-notes.md) and [64](64-multi-location.md) (step 5, staff limits);
`packages/core/src/visibility/`, `pack-roles.ts`, `pack-role-*.ts`, `principals.ts`, `users.ts`,
`invites.ts`, `operations/query.ts`, `dashboards/`, `ai/summaries.ts`, and
`packages/core/test/visibility-one-seam.test.ts`.

## Status

**Spec proposed (re-specced 2026-11-25).** The first spec (2026-11-05) was written for the CRM
alone, before the project became a platform with packs, customers and audiences (ADR 0400). The
owner decided on 2026-11-25 to re-spec it for what is on `main` now. This is that re-spec. It is not
built until the owner has answered the questions at the end and `docs/roadmap.md` says "spec
agreed". Nothing is built yet.

Numbers: block **CC** in [`parallel-work.md`](../parallel-work.md), migrations 1450 to 1469 and ADRs
0940 to 0949. Block I (0300 to 0309), claimed by the first spec, is released: a migration numbered
there would sort before the tables it changes (see Migrations and numbers).

## Goal

A business decides **who on its staff sees which records**, with the rules every mainstream CRM and
studio system ships, and the rules hold on every path at once: lists, record pages, counts, search,
similar records, exports, `query.sql`, dashboards, summaries, the assistant, MCP clients, approvals
and notifications. By default everyone on the staff sees everything, as today. An admin may set an
object to **own team** or **own**, so people see their own records, or their team's. A **Manager**
sees their teams' records. **Read-only** users look but change nothing. A business with several
locations may limit a manager or a member to the locations they work at, as stage 64 already does
for coaches and the desk.

All of it sits on the one seam that already decides what customers, the public, practitioners and
pack roles reach. Stage 14 adds the staff half of that seam and closes the reads that still bypass
it. It does not add a second permission system.

## Who it is for

- **A sales team on the CRM** (Deals, Leads): five to fifty people, each owning their deals and
  leads, some managers. The case the first spec was written for, and still the reason for owner
  policies.
- **A gym or studio with managers** (the first client is a gym): an owner, one or two managers, a
  front desk, coaches. Coaches and the door already hold pack roles with narrow reach; the desk is a
  grant. What is missing is a Manager role, Read-only for a bookkeeper or a partner, and, at two
  locations, a site manager who sees only their site.
- **Not yet:** a company that signs in with its own identity provider and provisions users by SCIM
  (14b, deferred until a customer needs it).

## What exists today (from the code, checked 2026-11-25)

- **Roles.** `admin`, `member`, `viewer` (`ROLES`, `principals.ts`), stored in `core_user.role` with
  a `CHECK` (migration 0002). Permissions are object-agnostic (`ROLE_PERMISSIONS`); every role reads
  every record. `core_user` is Better Auth's table, and 42 foreign keys in the migrations reference
  it, 14 of them `ON DELETE CASCADE`.
- **Grants** (ADR 0449): a human admin grants an account named permissions on top of its role
  (`user.setPermissions`, `core_user.granted_permissions`). Read on every call in one statement with
  the pack role (`loadStaffRights`). **Restricted** permissions (ADRs 0625, 0832: the notes
  permissions, `orders:payments`, `invoices:payments`, a pack's restricted ones) are held by admins
  and by a grant only, never by another role, never granted to oneself.
- **Pack roles** (ADR 0436): a fixed role a pack declares (Bookings' `coach`, Ticketing's door,
  `rostering.team`, Programs' `coach`, Jobs' `crew`), stored in `core_user.pack_role`. While held,
  the account may call exactly what the role lists. Its **reach** is limited by the role's own
  declarations, held by the pipeline before the operation runs: today's records only (ADR 0553), the
  People its holder looks after (ADR 0889), the records naming its holder (`mine`, ADR 0755). A grant
  that opens a tool lifts the role's limit on that call (ADR 0600). One authority allows each call
  (`staffAuthority`).
- **Invites** (ADR 0455): `user.invite`, `user.invites`, `user.updateInvite`, `user.revokeInvite`;
  `core_user_invite` with `role` (same `CHECK`), `pack_role` and `granted_permissions`; accepted by
  the code sign-in or the first request under Access; seats counted at invite and accept. No teams.
- **The seam** (`packages/core/src/visibility/`, ADRs 0244, 0410 to 0414). `scopeOf(principal,
  object)` gives a customer, the public and a practitioner (stage 43, designed) their scope; **staff
  always get `all`**: the plain view, no predicate (`test/visibility-staff-unchanged.test.ts`). Door
  1 (`visibleSource`, `visibleTable`) is built and serves every list, get, count, groups, export,
  trash list, search and similar-records hydration (`loadDisplays`). Doors 2 (user SQL) and 3
  (search with hidden hits) are not built.
- **Row rules already in the seam.** Note levels (`visibility/notes.ts`, ADR 0830): `coaches` and
  `sensitive` notes are out of every bulk path and read only through `visibleTable(ctx,
  "activity")`, by their author, admins, the staff who look after the Person, and holders of
  `notes:clients` or `notes:sensitive`; no AI actor reads them. Private activities (`private_to`,
  ADR 0112) and private conversations (ADR 0740) are out of the views. Restricted fields (ADR 0811)
  are in no view at all.
- **The ratchet.** `test/visibility-one-seam.test.ts` lists the reads of a record view or table
  still outside the seam, by file, count and reason. Of the reasons, three are reads for a caller
  that ADR 0410 left "for stage 14a": **`sql`** (SQL text run by `query.sql`, dashboards and the
  assistant's routines and producers: 25 reads in 5 files), **`later`** (summaries, assistant
  memory, duplicates: 22 reads in 3 files) and **`part`** (emails, phones, links, tags,
  affiliations reached from a record already read: 21 reads in 8 files). The other reasons (`org`,
  `write`, `host`, `access`, `agreements`, `invoices`, `inbox`, `codes`, `outside`, `role`,
  `intake`, `finance`, `birthday`) are reads with no caller, a write's own checks, or host code that
  answers no record to anyone.
- **Owners.** `core_person.owner_id` and `core_organisation.owner_id` (indexed; `ownerField` on the
  two objects). The SDK has `owner` on an object, naming a `user` field (`manifest.ts`); Deals,
  Leads and Forms' submission declare it. Assignment rules (stage 15, ADR 0246) set owners. Tasks
  have `assignee_id` and no owner declaration.
- **Locations** (stage 64): `core_location` is built (step 1, migration 1390). `located` (step 2)
  and the staff limit (step 5, `core_user_location`, migration 1391) are not. Stage 64 limits only
  accounts whose access is a pack role or grants, and leaves "limiting managers and the owner to
  locations" to this stage, because it needs doors 2 and 3.
- **Dashboards** cache results 60 s keyed by `visibilityScope(user)`, which returns `role:<role>`
  (`dashboards/cache.ts`). AI summaries are one shared row per subject (`core_ai_summary`).

## Decided at the first interview (2026-11-05), kept

1. **Unowned records** under `own` and `own team` are visible to everyone who can see the object,
   so unassigned leads and imported records stay findable.
2. **Related titles stay visible.** A visible record that links to a hidden one shows the hidden
   record's title, not a link; opening it says "You don't have access to this record".
3. **Members importing** is off by default with an admin setting to turn it on. It belongs to stage
   12 (Import), which is not built and already plans `records:import`; it moves there (below).
4. **SCIM-managed users' roles**: the identity provider is the source of truth. Kept for 14b.

## The design in one page

**Two kinds of staff account, as today.** A **full-role** account (Admin, Manager, Member,
Read-only) works across the business. A **fixed-role** account (a pack role: coach, door, team,
crew) reaches only what its pack declares. Grants add permissions to either, as built. Stage 14
adds Manager and the Read-only label to the first kind, and teams; it changes nothing about the
second.

**Who sees which records is one question asked at one place.** The seam's `scopeOf` gains a staff
scope. For every staff caller and object it combines every limit that applies to the account into
one predicate on the object's view. When nothing applies (every policy is Everyone, no locations
set: every host today), the scope stays `all`, the plain view, and nothing changes in cost or
behaviour.

**The limits, and one rule for how they combine.** A staff call is allowed by one authority (its
role, a grant, or its pack role, as `staffAuthority` decides today). What it may then read or
change is the records that pass **every** limit that applies to the account, at once:

| # | Limit | Applies to | Where it is held |
| --- | --- | --- | --- |
| 1 | The object's **visibility policy** (Everyone, Own team, Own) | Managers, Members, Read-only, and fixed-role accounts, on an object with an owner | The seam (new) |
| 2 | The account's **locations** | Every account but admins, on a located object, when the account has locations set | The seam (new for full roles; stage 64 step 5 for fixed roles, the same predicate) |
| 3 | The **pack role's reach** (today, looks after, mine) | A fixed-role account, only on a call its pack role allowed | The pipeline, as built (ADRs 0553, 0889, 0755) |
| 4 | **Row rules** of the object: note levels, private activities and conversations, authored rows, restricted fields, what an AI actor may not read | Everyone, as each already says | The seam and its operations, as built |

- **Limits only narrow, and they intersect.** A record hidden by any one of them is hidden.
- **A permission never widens a limit.** It opens operations, or a row rule it names
  (`notes:clients` reads `coaches` notes), and then only on records the other limits leave
  visible. The one exception is the one already built: a grant that opens a tool lifts the pack
  role's own reach (limit 3) on that call (ADR 0600). It never lifts 1, 2 or 4.
- **Admins** are outside limits 1 and 2. They are inside 4 where it says so (an admin's AI
  assistant still reads no kept note).
- **AI actors** (the assistant, MCP clients, extension code called by a person) act as the person
  and get the person's scope, then whatever row rules take from an AI. **Automations and jobs with
  no caller** read org-wide (`orgReader`), as ADR 0244 decided; what they send a person is
  delivered only if that person can see the record.

**Owner-based visibility.** An object with an owner (Person, Organisation, Task by its assignee,
and any pack object that declares `owner`) may be set by an admin to:

| Policy | Admin | Manager | Member | Read-only |
| --- | --- | --- | --- | --- |
| **Everyone** (default) | everything | everything | everything | everything |
| **Own team** | everything | own, their teams', unowned | own, their teams', unowned | own, their teams', unowned |
| **Own** | everything | own, their teams', unowned | own, unowned | own, their teams', unowned |

"Their teams'" means records owned by anyone in any team the account belongs to. Read-only reads
what a Manager in the same teams reads and writes nothing: it is the seat for a partner, an
accountant or a head coach who needs to look across a team. A fixed-role account is a Member here.

**Inherited, not owned.** Records without an owner of their own follow their parent: an activity is
visible if the caller wrote it, or it links to nothing, or it links to at least one record the
caller can see (and its row rules allow it); an affiliation follows its Person; emails, phones,
domains, addresses, tags and links follow their record. A pack object without an owner has no
policy: it is visible as today, and a hidden record it points to shows its title only (decided item
2).

**The seam's three doors all apply the scope.** Door 1 (`visibleSource`, `visibleTable`) wraps the
view in the predicate. Door 2 rewrites every restricted `rec_*` view a user's SQL names (in
`query.sql`, dashboard widgets, the assistant's routines and producers) into a generated CTE with
the same predicate, before the validated SQL runs. Door 3 leaves the search indexes unfiltered and
drops hidden hits at hydration, which already goes through door 1; vector search over-fetches so a
restricted user still gets a full page. Everything that stores or caches what depends on
visibility (dashboard results, AI summaries) is keyed by the caller's scope.

**Moving the rest of the ratchet in.** Every `sql`, `later` and `part` read moves onto the seam, and
those three reasons are deleted from the test, so a read for a caller can no longer be listed. What
stays listed is work with no caller, a write's own checks and host code, each with its reason; the
test stays a ratchet on those.

**Locations for full roles.** Stage 64 step 5 builds `core_user_location` and holds the limit for
fixed-role accounts. This stage puts the same predicate in the seam, so it also holds for Managers,
Members and Read-only users with locations set, through all three doors. Admins are never limited.
An account with no locations works everywhere. People are not located (stage 64 decided members are
shared), so a location limit narrows classes, bookings, shifts and the other located records, never
who the members are.

### What was weighed and rejected

- **Rebuilding `core_user` to change its role `CHECK`** (the first spec's plan). D1 enforces foreign
  keys, and dropping `core_user` fires the `ON DELETE` actions of the 42 keys that reference it:
  every session and device session would be deleted and two dozen columns naming an account set to
  null. Instead a new
  column `core_user.staff_role` carries the four roles, and `role` is kept as a mirror that never
  says more than the account holds (below).
- **A list of owner ids bound per call** (`json_each(?)`, the first spec's predicate). A manager of
  a large team would bind a long list, near D1's 100 bound values a statement. A subquery on
  `core_team_member` binds only the caller's id, as the pack-role reaches already do (ADRs 0755,
  0889), and is never stale.
- **Holding staff visibility in the pipeline**, as the pack-role reaches are. That works for a
  fixed role because it may call four or five operations and the pipeline refuses the rest. A full
  role calls hundreds, `query.sql` and dashboards among them; only the seam can filter all of them.
- **Admin-composed custom roles** ("Front desk", "Head coach" as named sets of permissions). ADRs
  0449, 0600 and 0625 left room for them. Grants already give any account any grantable
  permission; a named set is a convenience on top that can come later without changing the seam.
- **Separate read and write policies** ("everyone sees, only the owner edits"). A common option in
  CRMs, and a real choice for the owner (question 4); not in the default build.
- **Teams as locations, or locations as teams.** Stage 64 rejected the first; this spec agrees.
  Teams group people for owner-based visibility; locations place records. Two dimensions on one
  seam.
- **Building the SSO and SCIM seams now** (`Principal.groups`, `external_id`, `managed_by`, a group
  mapping table). Nothing would read them until a customer needs SSO, and they are small enough to
  add then.

## Platform work and pack work

All of this stage is platform work. No pack changes, except that a pack object that wants a policy
declares `owner` (Deals, Leads and Forms already do), and a pack's tools read through the seam as
they already must. A pack role's reach declarations (`today`, `looksAfter`, `mine`) are unchanged.

## The model

### Words (added to `CONTEXT.md` by the build)

- **Full role**: Admin, Manager, Member or Read-only. Stored in `core_user.staff_role`.
- **Fixed role**: a pack role (CONTEXT.md, Pack role). Unchanged.
- **Manager**: a Member who also sees the records owned by the members of their teams wherever an
  object's policy is not Everyone.
- **Read-only**: reads what a Manager in the same teams reads; holds no write. Stored as `viewer`.
- **Team**: a named group of staff accounts. An account may be in several. Teams decide visibility
  only.
- **Visibility policy**: per object with an owner: Everyone, Own team or Own.
- **Staff scope**: what the seam gives a staff caller for one object: `all`, or the predicate made
  from the limits that apply.
- **Limit**: anything that narrows which records an account reaches (the table above).

### Records

| Table | Columns | Notes |
| --- | --- | --- |
| `core_user.staff_role` (new column) | `admin`, `manager`, `member`, `viewer`, `CHECK`ed | Filled from `role`. The code reads only this. `role` stays as a mirror kept by a trigger: `manager` is mirrored as `member`, so any code still reading `role` sees less, never more |
| `core_user_invite` (remade) | `role` allows `manager`; `teams` (JSON list of team ids) | Nothing references the invite table, so it is remade with its rows |
| `core_team` | `id`, `name` (unique, any case), `created_at`, `created_by`, `updated_at` | Deleting a team removes its memberships |
| `core_team_member` | `team_id`, `user_id`, `added_at`, `added_by`; primary key on both; index on `user_id` | |
| `core_visibility_policy` | `object` (registry name, primary key), `policy` (`team`, `own`), `updated_at`, `updated_by` | No row means Everyone. Policy, so audited and kept |
| `core_ai_summary` (remade) | gains `scope_key` in its primary key | `all` for a summary drawing on nothing restricted for its reader; otherwise a hash of the reader's scope |

Tasks declare their assignee as their owner (`ownerField: "assigneeId"`), so a task can be given a
policy and assignment rules may name tasks.

### The staff scope (in `visibility/`, ADR 0940)

- `scopeOf(principal, object)` returns, for a staff principal, `all` or `{ kind: "staff", owner?,
  locations? }`. It stays pure: what it needs (the policies that are not Everyone, whether the
  account is in a team, whether it has locations) is read by the pipeline in the one staff statement
  it already makes (`loadStaffRights`, joined to `core_visibility_policy` and two `EXISTS`), and
  carried on the principal. An account on a host where every policy is Everyone and no account has
  locations reads exactly what it reads today.
- The owner predicate: Own is `(owner IS NULL OR owner = :me)`; with team reach it adds `OR owner IN
  (SELECT m.user_id FROM core_team_member m JOIN core_team_member mine ON mine.team_id = m.team_id
  WHERE mine.user_id = :me)`. One bound value, the owner index used.
- The location predicate is stage 64 step 5's, moved into `visibility/locations.ts`: a located
  record's location is one of the account's.
- Inherited predicates: activities, affiliations and the parts of a record get theirs from their
  parents' scopes; the activity predicate is added to the note scope (`notes.ts`), not beside it.
- Customers, the public, practitioners and devices are untouched: their scopes do not read the
  staff scope, and the staff scope never reaches them.

### Writes

- A staff write may change only a record the caller can see (the snapshot before a write is read
  through `visibleTable`, which already exists); a hidden one is not found.
- A new record's owner is the creator unless the caller or an assignment rule names another.
  Changing the owner to someone else warns when the caller will no longer see it.
- A create or import that meets another record's email or domain that the caller cannot see says
  "A record you can't see already uses this email; ask an admin", and shows nothing of it.
- Merging needs both records visible. Erase is an admin's already.
- Fixed-role writes stay as their pack role's reach says, and also pass limits 1 and 2.

### Operations

| Operation | Who | Notes |
| --- | --- | --- |
| `user.updateRole` | `users:manage`, human, not on MCP (as today) | Accepts `manager`. A pack role is still set with `user.setPackRole` |
| `user.invite`, `user.updateInvite` | as today | Take `manager` and `teams` |
| `team.list`, `team.get` | every full role | Members of each team; a fixed role does not reach them |
| `team.create`, `team.update`, `team.delete`, `team.addMember`, `team.removeMember` | `teams:manage` (new, admins), `actors: ["human"]`, not on MCP, audited | Teams decide visibility, and visibility is policy |
| `visibility.list` | every full role | Each object with an owner, its policy and a sentence saying who sees what |
| `visibility.set { object, policy }` | `policy:manage`, `actors: ["human"]`, not on MCP, audited | Refused for an object with no owner. Tightening and loosening are both a human admin's (identity and policy are not AI-configurable) |

`teams:manage` is not grantable. Nothing in this stage is opened to `customer`, `public`,
`practitioner` or `device`.

### Every surface

- **UI, MCP, the assistant, Code Mode and a person's pack tool runs** call operations as the person,
  so the seam covers them. MCP stays role ∩ scopes for permissions; visibility is the person's.
- **`query.sql`, dashboards, routines and producers** go through door 2. The validator refuses a user
  CTE named `rec_…` or `__vis_…`, closing the gap where a user CTE shadows a view name.
- **Dashboards' cache** is keyed by a hash of the caller's scopes for the objects the widget reads,
  so callers with equal scopes share an entry and nobody else does.
- **Search, hybrid search and similar records**: hidden hits dropped at hydration; vector queries
  over-fetch (three times `topK`, at most 100); `record.similar` requires the source record visible.
- **Summaries** are keyed by scope; `summary.get` requires the subject visible.
- **Assistant memory** reads its records through the seam; a remembered fact about a record the
  person can no longer see is not shown.
- **Duplicates**: a pair is suggested only when both records are visible.
- **Approvals**: a non-admin sees and decides only change sets whose records they can all see.
- **Notifications and digests** about a record go only to recipients who can see it; skipped ones
  are a line in the run's report.
- **The inbox** (stage 36) keeps its own rule (shared by the staff; private conversations for admins
  and whoever has it). A conversation's Person's name shows as a related title. Team assignment of
  conversations is not in this stage.
- **Restricted fields** (`record.readRestricted`) additionally need the record visible.
- **Users** stay visible to every full role (owner pickers, assignees).

### Screens

- Settings → Users: the role column shows Admin, Manager, Member, Read-only or the pack role; teams
  per user; the invite dialog takes a role and teams.
- Settings → Teams: teams with their members.
- Settings → Visibility: one row per object with an owner, the three options and one sentence each,
  and, for Person, a line saying that looking after a client does not open a Person the policy
  hides, and that the desk's member lookup follows the policy too.
- A record page opened by id that the caller cannot see: "You don't have access to this record."

### What an AI may do

Read and write as the person it acts for, inside that person's scope and the row rules. It cannot
create, change or delete teams, set a policy, change a role or set an account's locations: those
operations are `actors: ["human"]` and not on MCP.

### Privacy and audit

Policies, team memberships, roles and an account's locations are policy: every change is audited
(who, when, before and after) and kept after the account leaves. An export holds what the caller
can see, with no count of the rest.

## Out of scope

- **14b, SSO and SCIM**: deferred until a customer needs it. When it comes: OIDC and SAML through
  Better Auth configured by env only, Cloudflare Access groups, SCIM 2.0 with an env-only token,
  group to role and team mappings edited by human admins, and decided item 4.
- **`records:import`** and "Members can import": with stage 12, which owns importing. When stage 12
  adds the permission, a new host starts with the setting off and an existing host keeps today's
  behaviour (members import) until an admin turns it off.
- Admin-composed custom roles; permission sets.
- Separate read and write policies, unless the owner chooses them (question 4).
- Sharing one record with one user; territory and role hierarchies deeper than a Manager over their
  teams; teams of teams.
- Team assignment in the shared inbox and team queues (stage 36's follow-up).
- Restricting who sees the list of users.
- Location limits for admins.

## Acceptance criteria

1. **Nothing changes by default.** With every policy Everyone and no account limited to locations,
   `test/visibility-staff-unchanged.test.ts` and the `rows_read` budgets (`rows-read.test.ts`,
   `dashboards-rows-read.test.ts`, `ai-rows-read.test.ts`) pass unchanged; the staff statement makes
   no extra statement.
2. **Roles.** Manager and Read-only behave as specified on the web, MCP and the assistant;
   `staff_role` is filled for every existing account; the `role` mirror never holds more than
   `staff_role`; the first-user-admin rule still makes the first account an admin; sign-in, device
   sessions and invites work on a seeded copy after the migration, and no session is lost.
3. **Teams and invites.** Admins manage teams; team and policy writes are refused for every
   non-human actor and are not on MCP; an invite signs a person up with its role and teams; expired
   and revoked invites still fail; seat limits still apply.
4. **Policies.** For Person, Organisation, Task, `deals.deal` and `leads.lead`, each of Everyone, Own
   team and Own shows exactly the table's records to an Admin, a Manager, a Member, a Read-only user
   and a fixed-role account, unowned records included, through list, get, count, groups, board,
   export, search (full text and hybrid), similar records, record tabs and panels.
5. **Inherited.** Activities, affiliations and record parts follow their parents; a note's level and
   its parents' visibility both hold; hidden related records show their titles without a link.
6. **SQL.** `query.sql`, dashboard widgets, routines and producers return only visible rows under a
   restricted policy, through joins, subqueries and CTEs; a user CTE named `rec_person` or `__vis_x`
   is refused; ADR 0020's validator tests still pass.
7. **One seam.** The ratchet's `sql`, `later` and `part` reasons are gone and their reads are on the
   seam. A registry-wide test runs every operation that returns records (core and every shipped
   pack) against a fixture with Own policies, team members and a location limit, and fails when a
   hidden record's id, title or field value appears, or when an operation is missing from its
   table.
8. **The rule.** Tests show each pair of limits intersecting: a policy and a location; a policy and a
   pack role's reach (the coach's "looks after" and a Person hidden by Own); a policy and a note
   level; a grant lifting a pack role's reach but not a policy or a location; an admin outside
   policies and locations but not outside the AI note rule.
9. **Caches and stored output.** Two callers with different scopes never share a dashboard cache
   entry or a summary; callers with equal scopes do.
10. **Writes, approvals, notifications, uniqueness, merge, duplicates and memory** behave as
    specified.
11. **Locations for full roles.** A Manager and a Member limited to one location see only its
    located records through every door; an admin sees every location; People stay shared.
12. **Cost.** Under Own and Own team, budgets for a list page, search hydration, a count and a
    dashboard over activities hold on the 3,000-person seed, `EXPLAIN QUERY PLAN` showing the owner
    index used.
13. `pnpm lint typecheck test` pass, with one e2e test per journey (an admin sets People to Own and a
    Member sees only theirs in the list, search, the assistant and a dashboard; a Manager sees their
    team's deals). ADRs written, `CONTEXT.md`, `docs/architecture.md` and the docs site updated.

## Dependencies

- **Built:** stage 22's seam, ADRs 0436, 0449, 0455, 0553, 0600, 0625, 0755, 0811, 0830 to 0832, 0889;
  stage 15 (owners, assignment rules); stage 64 step 1.
- **Stage 64 step 5** (the location limit for fixed roles) builds `core_user_location`. Step 6 of
  this stage waits for it and for stage 64 step 2 (`located`). If stage 64 step 5 is built first, it
  should put its predicate in `visibility/locations.ts` so the pipeline hold and the seam share it.
- **Stage 43 step 5** (the practitioner scope) also changes every read path in the seam: it and this
  stage's steps 1, 2, 3 and 5 run one after the other, never beside each other.
- **Stage 12** (Import) takes `records:import` from this spec. **Stage 13** (Email) and **stage 16**
  (Duplicates) read through the seam and inherit the rules.
- Reserved area: "Visibility and permissions anywhere: Stage 14, once it starts"
  (`parallel-work.md`). Claim it when step 1 starts.

## Migrations and numbers

Block **CC** (migrations 1450 to 1469, ADRs 0940 to 0949). A fresh database applies migrations in
number order, so a remake must sort after every earlier change to its table: `core_user` was last
changed by 0471 and `core_user_invite` created by 0490 and changed by 0770; `core_ai_summary` by
0255; stage 64's `core_user_location` is 1391. Numbers in block I (0300 to 0309) would sort before
0471 and 0490 and are not used.

| Migration | What |
| --- | --- |
| 1450 | `core_user.staff_role`, filled from `role`; the mirror trigger; the first-admin trigger made to set both; `core_user_invite` remade with `manager` and `teams` |
| 1451 | `core_team`, `core_team_member` |
| 1452 | `core_visibility_policy` |
| 1453 | `core_ai_summary` remade with `scope_key`, carrying 0255's columns |

| ADR | What |
| --- | --- |
| 0940 | The staff scope in the seam and the one rule for how limits combine (amends 0244, 0410, 0600 with notes) |
| 0941 | Door 2: user SQL rewritten at the seam, as built |
| 0942 | Door 3 and stored output: hydration, over-fetch, summaries and caches keyed by scope |
| 0943 | Manager and Read-only, `staff_role` beside `role`, teams (amends 0245, 0449, 0455) |
| 0944 | Visibility policies, owners and inherited visibility |
| 0945 | Location limits for full roles (amends stage 64's ADR 0914, if written) |

## Suggested build order

| Step | What | Files or areas | Security-sensitive | Beside |
| --- | --- | --- | --- | --- |
| 1 | The staff scope type (still `all` for everyone); the `part` and `later` reads onto the seam (record parts, summaries' reads, memory, duplicates); the registry-wide staff test with a fixture policy injected in the test | `visibility/`, `records/links.ts`, `records/tags.ts`, `operations/affiliation.ts`, `operations/activity.ts`, `ai/summaries.ts`, `assistant/memory.ts`, `operations/duplicate.ts`, the one-seam test | **Yes** | **Alone in the seam.** Not beside stage 43 step 5 |
| 2 | Door 2: the SQL rewrite in `runReadOnlySql`, the CTE name refusal, dashboards' cache key; the `sql` reads moved | `operations/query.ts`, `dashboards/`, `assistant/routines.ts`, `assistant/producers.ts`, `assistant/routine-backtest.ts` | **Yes** | After 1. Beside 4 |
| 3 | Door 3 and stored output: over-fetch, `record.similar`'s source check, summaries' `scope_key` (1453), duplicates' pairs | `visibility/`, search, `ai/`, `duplicates/`, `packages/db` | **Yes** | After 1. Beside 4; not beside 2 (both touch `visibility/`) unless one session does both |
| 4 | Roles and teams: `staff_role` (1450), Manager and Read-only, `teams:manage`, teams (1451), invites with teams, Settings → Users and Teams | `packages/db`, `principals.ts`, `pack-roles.ts` (`staffAuthority` reads `staff_role`), `users.ts`, `invites.ts`, `operations/team.ts`, `apps/app` | Yes (the migration: run it on a seeded copy first) | Beside 2 or 3. Not beside stage 64 step 5 (`pack-roles.ts`) |
| 5 | Policies: `core_visibility_policy` (1452), tasks' owner, the owner and inherited predicates in all three doors, writes, the owner-change warning, uniqueness messages, approvals, notifications, Settings → Visibility, cost budgets, e2e | `visibility/`, `operations/`, `notifications/`, `approvals`, `apps/app` | **Yes** | After 1 to 4. **Alone in its window**: it changes every read path |
| 6 | Locations for full roles: the predicate in the seam for Managers, Members and Read-only, through every door | `visibility/locations.ts`, the registry-wide test | **Yes** | After 5 and after stage 64 steps 2 and 5 |
| 7 | Docs: `CONTEXT.md`, `docs/architecture.md`, the docs site, `SITE.md` checked | docs | No | Last |

Steps 1 to 3 alone are worth building even if no business restricts anything yet: they close every
read for a caller that bypasses the seam, which stages 43 and 64 also rely on.

## Decided by this spec, open to override

Decided as the familiar, conventional design, without asking:

1. Four full roles (Admin, Manager, Member, Read-only) and the fixed pack roles as built; no custom
   roles.
2. Per-object policies Everyone, Own team, Own, set by a human admin; Everyone by default.
3. A Manager sees their teams' records under Own; under Own team everyone does; Read-only reads like
   a Manager and writes nothing.
4. Teams are flat, an account may be in several, and only admins manage them.
5. Every limit narrows and they intersect; a permission never widens a limit; the only lift is ADR
   0600's grant over a pack role's own reach.
6. Admins are never limited by policy or location.
7. Location limits apply to Managers, Members and Read-only users who have locations set; empty means
   everywhere; People are never located.
8. The stage 56 rule stands: no full role holds `notes:clients`, `notes:sensitive` or `notes:manage`
   by role; a business grants them.
9. Visibility is enforced in the seam, not by screens, blocks or client apps.
10. Automations read org-wide; their messages reach only those who can see the record.
11. Users are visible to every full role.
12. `staff_role` beside `role`, not a `core_user` rebuild.
13. SSO and SCIM, custom roles, read-and-write split, team inbox assignment: later.

## Risks

- **Security:** a read path that does not take the scope leaks. The registry-wide test and the end
  of the `sql`, `later` and `part` reasons are the guards; the SQL rewrite is tested against the
  validator's own corpus.
- **Migration:** `staff_role` touches the table every sign-in reads. It adds a column and two
  triggers and drops nothing; it is run on a copy of a seeded database, and of the first client's
  database, before release.
- **Cost:** a restricted caller pays a subquery on lists and an `EXISTS` per activity row on
  activity-heavy dashboards. Budgets are set for both; a host that never restricts pays nothing.
- **Surprise:** a business that sets People to Own will find its desk and coaches see fewer members.
  The Visibility screen says so before the change is saved.

## Questions for the owner

Four questions. Everything else above is decided; each answer has a default the build can start
with.

1. **Which business needs this first, and for what?**
   - A. A gym or studio with several locations, whose site manager should see only their site.
   - B. A sales team on the CRM, whose people should see only their own deals and leads.
   - C. Both, or a business you are talking to now that needs something else (tell me).
   - D. No one yet.
   - **Default: D.** Build steps 1 to 4 (closing the reads that bypass the seam, Manager, Read-only,
     teams), which every answer needs, and build step 5 (owner policies) or step 6 (locations) when
     a business asks. Building rules nobody uses yet costs review and testing on every later stage.
2. **What may a Manager do beyond a Member, without being granted it one by one?**
   - A. Only see their teams' records. Refunds, discounts, finance reports and the rest stay granted
     person by person, as today.
   - B. Also refund, discount, end or keep a membership going, and read the finance reports, by
     role.
   - **Default: A.** Grants already take a minute per person in Settings → Users. Making them part
     of the role hands money powers to everyone called Manager, including someone promoted for
     another reason.
3. **May a Manager invite staff and put them in teams?**
   - A. No. Only admins invite, change roles and manage teams (as today).
   - B. Yes, but only as Members or Read-only users, and only into the Manager's own teams.
   - **Default: A.** Who can sign in to the business's system is the most sensitive setting it has.
     Option B is common in larger teams and can be added later without changing anything else.
4. **Do you need "everyone can see it, only its owner can change it" now?**
   - A. Not now. Whoever can see a record and has a role that writes may change it.
   - B. Yes, as a second setting per object beside who can see it.
   - **Default: A.** It is a familiar option in sales CRMs, but no business on the platform has asked
     for it, and it adds a second rule to every write. It can be added on the same seam later.
