# ADR 0600: A pack role and its grants add up; the front desk's permission

Status: accepted, 2026-11-23 (issue #258). Amends ADRs
[0436](0436-pack-roles-and-the-door-role.md) (pack roles),
[0449](0449-permissions-granted-one-by-one.md) (grants) and
[0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (the coach role, today
only). Ahead of stage 14a's roles and teams ([ADR 0245](0245-roles-teams-and-identity-seams.md)),
which build on it.

## Context
The owner's decision (2026-11-23): at the first client, coaches and the front desk are the same
people. "It's ok if we manage this with permissions so coaches can have that permission too. But
don't make it so it's one or the other." So a coach may also hold the desk's abilities; roles and
permissions add up; least privilege stays the default.

Before: a pack role replaced the account's role and emptied its grants (ADR 0436, ADR 0449's
amendment), so a coach who worked the desk needed an ordinary staff role (which holds every
record, people and orders included) or two accounts. The desk's tools (`bookFor`, `findPeople`,
`cancelFor`, `move`, `classList`) declared no permission, so nothing could name "the desk" as
something to give. And the coach role's limit to today (ADR 0553) was carried on every call the
account made, so even with a grant a coach's `bookFor` into next week would have been refused by
the limit on its own nested `record.create`.

An ordinary staff member (a `member`, no pack role) already did both: every tool, any day, one
sign-in (`apps/runner/test/bookings-coach-desk.test.ts`, the first test). Nothing there needed
fixing.

## Decision

### The desk's permission
Bookings declares `bookings:desk` on its desk tools and declares it `grantable`, with plain words
for the admin (`grantableLabels`, new in the manifest):
- `findPeople` (name and email of People on file, at most 10, by a search of two letters or more),
- `bookFor` (a member on file, or a walk-in made with their booking; paid at the desk; onto the
  waitlist),
- `cancelFor`, `move`,
- `returnUse` (a person's own act, `humanOnly`; its permission was `bookings:returns`, which no role
  held and nobody could be granted, so the rename takes nothing from anyone),
- `classList` (the desk's list: holders and desk payments),
- `day`, any date (shared with the coach role: see below).

Not in it: `cancelClass` (keeps `bookings:cancelClasses`, `personApproves`, a person's), refunds
(`orders:refund`, core, and never for a pack role's account), people, orders, passes and
memberships records, settings, search, exports, `query.sql`, the assistant. The desk permission
opens **no** generic read: `record.get`, `record.list` and every core operation stay as the role
leaves them. What the desk tools read, they read as the extension and return only what their
output declares.

Members and admins hold the desk tools as before (a tool permission never takes anything away,
ADR 0436); a viewer granted `bookings:desk` holds them too.

### A tool may name more than one permission
`permission` on a tool is one name or a list, any one of which opens it (`toolPermissions` in the
SDK; `packPermissions` and `packGrantable` on the tool's operation). Bookings' `day` is
`["bookings:coach", "bookings:desk"]`: the coach reaches it through the role, held to today, and
the desk any day. Each name is checked as before (`<pack>:<word>`, once each).

A tool naming both a permission a role holds and a grantable one must say so on purpose:
`grantLiftsRoleLimits: true` (set on `day` only). Without it the contract check refuses the tool,
and the host does not open it to the grant either, so adding `bookings:desk` to `roster` or
`markAttended` later cannot lift the today limit off the coach's own tools by accident. The flag on
a tool that does not name both is refused too.

### What a pack role's account may be granted
- **Only pack permissions a shipped, installed pack declares grantable** (any such pack, not only
  the role's own: a coach at the desk may also be given `memberships:passes`). Each opens only the
  named tools of that pack. `user.grantablePermissions` says which (`forFixedRole`).
- **Never a core permission** (`records:publish`, `orders:refund`, `subscriptions:manage`,
  `people:link`): each opens a core operation over every record of its kind, which is what a fixed
  role exists not to give. `user.setPermissions` and the invites refuse them for such an account
  (`invalid_input`), and `user.setPackRole` refuses a role to an account holding one (`conflict`:
  take it away first), so no inert grant sits on an account. A core grant stored anyway counts for
  nothing beside a pack role (the pipeline never consults it).
- **Never a permission one of the pack's roles holds**: the contract check refuses declaring
  `grantable` a permission a role lists, so a grant can never be "the coach role, without its
  limit". `bookings:coach` is not grantable; `bookings:desk` is held by no role.
- Who gives it: a human admin only (`user.setPermissions`: `users:manage`, `actors: ["human"]`, not
  on MCP), on the Users page. Never the assistant, an MCP client, an automation or the account
  itself. Audited as a change to the user, the list before and after.

### Grants stored before this decision (migration 0770)
Before, `user.setPermissions`, `user.setPackRole` and the invites could leave grantable pack
permissions stored on a pack-role account, where they counted for nothing. Honoured now, they would
come alive on upgrade with no admin's act. Migration 0770 clears every grant stored on an account
holding a pack role, and on pending invites with one: they counted for nothing, so nothing anyone
relied on is lost. One audit row (`migration.clearFixedRoleGrants`) says how many accounts and
invites were cleared, with each account's list before and after recorded on it; an admin re-ticks
what they want. The Users page sends only the grants an account may hold now, and shows any stored
grant that no longer applies (a removed pack's) so an admin can take it away.

### How a call's authority is decided
One function decides it, `staffAuthority(user, rights, op, input)` in
`packages/core/src/pack-roles.ts`, behind `staffMayCall`, which the pipeline asks on every staff
call. For an account with a pack role:
1. **`grant`**: a permission granted to the account is one of the tool's `packGrantable` (its
   pack still declares it grantable). Judged first, so a role's limit never blocks what a grant
   allows. Opens tools only, never a core operation.
2. **`packRole`**: otherwise the pack role allows it (ADR 0436's rule, unchanged).
3. Otherwise refused, before the input is parsed (`staffRightsReach`, the early check).

The limit to today travels only with `packRole`: `roleLimitsFor(rights, op)` returns the role's
`today` unless a grant opens `op` (input-independent, so the pipeline decides it before parsing).
The pipeline (`invokeOnce`, one line) sets `roleToday = roleLimitsFor(rights, op) ??
ctx.roleToday`: a call the grant allows starts a run without the role's limit; a call the role
allows starts a run that carries it into every operation and nested tool it calls (ADR 0553); a
limit a parent run carries is never dropped.

Call by call, for a coach granted `bookings:desk`:
- `bookFor`, `findPeople`, `cancelFor`, `move`, `returnUse`, `classList`: the grant; any day; their
  nested writes and reads are not limited.
- `day`: the grant (it names `bookings:desk`), so any date.
- `roster`, `markAttended`, `undoAttended`, `markNoShow`, `markAll`: the role; today only, their
  nested reads limited (another day's class or booking is not found).
- `record.get` and `record.list` on `bookings.class`: the role; today only (`record.count` and the
  rest refused, as before). On any other object: refused.
- Anything else: refused.

So the union is exactly "the coach role's reach, plus the granted tools' reach".

### Accepted, in plain words
- **A tool run a grant started calls other tools without the role's limit.** What a granted tool
  reaches includes what its own calls reach (a shipped pack's code, as for any staff member who
  holds the tool): a grantable tool that called `roster` would read another day's list. No shipped
  desk tool calls another tool. A pack author must not add a grantable tool that reads through a
  coach tool (or any role's limited tool).
- **What a coach with the desk permission can see.** `findPeople` returns up to 10 People's names
  and emails per search of two letters or more, so repeated searches can list the whole directory.
  `classList` shows, for any class on any day, every booking's person, state, whether they paid at
  the desk, the membership or pass it spent from, and who booked it. That is the desk's work, and
  it is what the admin's tick gives.

Without a pack role nothing changes: the role, or a core grant (`role`), else a grantable pack
permission (`grant`). Taking the pack role away leaves the account a viewer with its pack grants.

### The admin's tick
On Settings > Users, a staff member with a fixed role shows, under their row, one checkbox per
pack permission a fixed role may hold, in the pack's words ("Front desk: find people, book anyone
(walk-ins too) into any class, cancel or move their bookings, give a use back, and see any day's
classes and full lists. For a coach who also works the desk."). Ticking saves at once
(`user.setPermissions`). The invite form offers the same ticks beside a fixed role.

## Why
- The owner's rule is "add up, never one or the other", and the smallest unit that says "the desk"
  is a permission on the desk's tools: a coach gets exactly those tools and none of a member's
  record access.
- Deciding authority per call, in one function, keeps the today limit bound to what the coach role
  gives. Carrying the limit on the account (as before) would block the desk; dropping it whenever a
  grant is held would lift it off the roster. Judging the grant first, and only for tools that name
  the granted permission, gives neither.
- A list of permissions on a tool is the honest shape of "the day view is the coach's and the
  desk's". The alternatives (a second day tool, or a grant that implies a role's permission) either
  duplicate the tool or make a grant lift a role's limit.
- Core grants stay off fixed-role accounts because they are broad by design (every record of a
  kind); a pack permission is narrow by design (named tools, declared outputs).

## Proof
- `apps/runner/test/bookings-coach-desk.test.ts` (shipped packs, real host): an ordinary member
  does every coach and desk tool in one sign-in; a coach without the grant is refused every desk
  tool and sees no other day; with it, every desk tool works on a class six days ahead (a member
  booked, a walk-in made, the list, a move, a cancel, a use given back) while `roster`,
  `markAttended`, `markAll`, `record.get` and `record.list` stay today's; the grant opens nothing
  else (people, organisations, orders and refunds, bookings, passes and memberships records,
  `query.sql`, search, exports, views, settings, extension settings, users, the assistant's
  threads, `cancelClass`, `givePass`, another pack's grantable tool); a grantable fixture tool that
  calls `roster` and `classList` reaches another day through the grant while the role's own
  `roster` call still does not, and a run carrying the limit holds it on the same tool; the
  assistant, MCP, automations, a member and the coach cannot grant it; a core or role-held
  permission cannot be granted to a coach; a core-granted account is not given a pack role; the
  grant is audited with who gave it; removed, the next call is refused.
  Loosened, it fails: with the limit dropped whenever any grant is held, the granted coach's
  roster and the nested-tool tests fail; with the limit always carried (as before), those and the
  grant-and-revoke test fail (the desk's booking into next week is refused).
- `packages/db/test/fixed-role-grants-migration.test.ts`: migration 0770 clears a coach's and a
  door account's stored grants and a fixed-role invite's, leaves a member's and a plain invite's,
  and audits the count and each account's change. `packages/core/test/staff-invites.test.ts`: an
  invite with a fixed role and a core permission is refused. `apps/app/test/grants.test.ts`: the
  Users page sends only grants the account may hold.
- `packages/core/test/permission-grants.test.ts`: registry-wide, for a fixture pack shaped like
  Bookings (a role limited to today, a role tool, a grantable tool, a tool either opens): the grant
  never closes anything, opens exactly the tool naming it, carries the limit exactly when the role
  allows; core grants and a role-held permission as a grant change nothing; a grant stops counting
  when the pack stops declaring it; the contract refuses a role-held permission as grantable, and a
  role's tool given a grantable permission without `grantLiftsRoleLimits` (which the host then does
  not open to the grant).
- `packs/bookings/test/bookings.test.ts`, `packages/extension-check/test/check.test.ts`
  (`cos ext check` prints what each grantable permission opens).

## Consequences
- `cos ext check` prints, beside a pack's roles, each grantable permission and the tools it opens.
- The MCP surface still lists for a fixed-role account only what the role reaches; the pipeline
  decides every call, so this only under-lists. A role's typed client (`roles.json`, ADR 0451)
  covers the role alone; a coach who also works the desk uses the staff app for the desk.
- Stage 14a's composed roles and teams hand out sets of these grants; the authority decision stays
  in `staffAuthority`.
