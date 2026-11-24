# ADR 0872: The owner's client

Status: accepted, 2026-11-24 (stage 60, build step 6; decisions 2 and 8 of the stage's spec).
Amends ADRs [0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md) (a second short
list beside the role clients) and [0455](0455-staff-invites-and-native-sign-in-by-tokens.md) (a
staff device session's calls are marked). Builds on ADR
[0453](0453-pack-hooks-over-the-clients-operations.md) (hooks over the operations a client holds).
No migration.

## Context
The owner of a gym opens the business's own app on their phone to see today and to approve what
waits for them (stage 60). Staff sign in in that app only through a pack role's client (ADR 0451),
and an admin holds no pack role, so an admin had nothing typed to call there. Writing the whole
staff client into a company's app would put every staff operation's name and shape in a public
bundle, which ADR 0451 refuses. Separately, decision 8 says a change to how the system is set up
(an extension, new fields) is not approved from the phone, and the rule must hold in the host, not
only on the screen that says so.

## Decision
- **A fixed, short list, not a pack role.** `OWNER_CLIENT_OPERATIONS` in
  `packages/core/src/http/contract.ts`: `today.get`, `today.rows`, `today.alerts`,
  `today.setAlerts`, `approval.list`, `approval.get`, `approval.approve`, `approval.reject`,
  `notification.list`, `notification.unreadCount`, `notification.markRead` and `user.me` (and,
  once stage 30 adds it, its device registration). No `record.get` or `record.list`, no pack tool,
  nothing open to customers or the public. Adding a name is a reviewed change: each is in the
  company's public bundle.
- **The release says which of them it serves.** `roles.json` gains `owner: { operations }`: the
  list less any operation the release does not have yet (`ownerClientOperations`), generated with
  the contract and checked by the contract test. Today's own operations (stage 60 steps 3 and 5)
  join the file, and so the client, when their release carries them; a release before this one has
  no `owner` and `cos client generate` says to upgrade.
- **Opted into per app.** `product.ts`'s `mobile.owner: true`. `cos client generate` writes
  `roles/owner.ts` beside the role clients (`renderOwnerClient` in `packages/client-gen`), factory
  `createOwnerClient`, with only those operations; any other staff operation is a type error.
  The web app gets none (its binding never serves staff, ADR 0421); the web admin's Today uses the
  staff client it already has.
- **Any staff account may sign in with it, and the host decides every call.** It goes through the
  template's `staffSession` as a role client does (`staff.client(createOwnerClient)`), on the
  device's one staff session (ADR 0451). A coach who signs in with it reaches only what their pack
  role and grants allow (`packRoleReaches`); the client only types what such an account may ask.
- **Headless hooks in `@composable-os/client`** (`packages/client/src/owner.ts`): the operations'
  shapes as Today reads them (`OwnerOperations`), `createOwnerHooks` over `packHooks` (a hook whose
  operation the client lacks is not there, in the type and at run time), and the words the native
  block and the web Today share: an item's value and comparison, the business's local day,
  "Review on a computer" for a setup change (`needsComputer`), one action's approve input with the
  second step's words only once pressed (`approveInput`), and the host's refusals in the screen's
  words (`ownerFailure`). They hold no rule: which items, their numbers, their order and who may
  approve are the host's. Money, the drill-in rows and an approval's detail are read with
  `gcTime: 0`, and `forgetToday` drops them from the cache when the app goes to the background
  (ADR 0629's pattern).
- **A setup change is refused from the company's app, by the host.** The HTTP surface marks a
  staff call made with a device session (`origin.staffDevice: true`, from the session, never from
  the request; recorded in the audit row's origin). `approval.approve` (and `approval.decide`,
  which shares its body) refuses an `extension` or `schema` action under it, for an admin too,
  with `details.reason: "review_on_computer"`; rejecting one is allowed. The decision is still
  stored as `decided_via: "tap"`; no new value.

## Considered
- **A `client` column on the device session, set at sign-in to "owner".** The role clients and the
  owner's client share the device's one staff session (ADR 0451), so a session cannot say which
  generated file made a call, and the value would be the app's own claim. The mark is instead the
  session's kind, which the host knows, and it needs no migration. A staff device session is the
  company's app on a device or the command line's import door (ADRs 0457, 0470); the import door
  approves nothing, and a setup change is reviewed in the web admin, where its diff and impact are
  shown (ADR 0041).
- **The owner's client as a pack role.** A role is a set of rights; this is a set of calls whose
  answers depend on the caller's rights. Any staff account may use it.
- **Today's operation types generated rather than written.** They are written in the hooks entry
  as the account entry's are (stage 48), so the native block and the web Today compile before
  Today's operations ship; the step that adds `today.get` keeps its output to these shapes or
  changes both in the same change.

## Consequences
- Until stage 60 step 3 ships, the generated owner's client holds the approvals, the inbox and
  `user.me`; its Today hooks are absent (a type error to call), and appear when the repo
  regenerates against a release with them.
- A person who wants to approve an extension or a schema change from a phone cannot; they open the
  web admin.
- Push registration (stage 30) is added to the list when it is built.

## Tests
`packages/core/test/api-contract.test.ts` (the `owner` list is the listed staff operations the
release serves, none a pack's, none open to customers or the public, no `record.list`);
`packages/client-gen/test/generate.test.ts` (the built app names no other staff operation;
`record.list` and `person.list` are type errors; the owner's hooks wire through `staffSession`
with no cast; an operation the contract lacks is refused);
`packages/create-composable-os/test/client-repo.test.ts` (`mobile.owner: true` writes
`roles/owner.ts` with only its operations); `packages/client/test/owner.test.ts` (the words, the
second step, the refusals, `gcTime: 0` and `forgetToday`, the hooks a client can back);
`packages/core/test/owner-client-approval.test.ts` (a setup action refused from a device origin
for an admin and left waiting, rejectable; another action approved; the same setup action decided
from a browser); `apps/app/test/staff-app.test.ts` (an admin signed in on the phone through the
real native sign-in and HTTP surface is refused a setup approval with `review_on_computer`).
