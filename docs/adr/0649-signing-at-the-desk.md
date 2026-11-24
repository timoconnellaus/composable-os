# ADR 0649: Signing at the desk: a session a person starts, a tablet with no sign-in

Status: accepted, 2026-11-24 (stage 44, build step 6, built with stage 51's step 1). Builds on
[ADR 0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) (acceptances
and who may agree for whom), [ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md)
(the copy), [ADR 0646](0646-erase-merge-and-retention-for-agreements.md) (erase and merge),
[ADR 0780](0780-the-enrolled-device.md) (the enrolled device), [ADR 0402](0402-staff-and-customers.md)
(audiences), [ADR 0600](0600-a-pack-role-and-its-grants-add-up.md) (a fixed role and its grants)
and [ADR 0660](0660-pack-screens-in-the-admin.md) (screens). Stage 44's spec: "Signing at the
desk (decision 22)", criterion 15 and row 6 of the build order.

## Context
Decision 22: a member signs at the front desk, on the business's own tablet, as their own
acceptance: not a paper form staff type in, and not staff agreeing for them. The review of PR #266
showed what goes wrong with a code alone on a public page (anyone who saw it could sign as the
member on their own phone) and with a standing "front desk" sign-in (whoever picks the tablet up
reaches every member's documents). The spec settled the design; this records what was built.

## Decision
- **Two things together open a session, and neither does anything alone.**
  1. The tablet is an **enrolled device** of use `signing` ([ADR 0780](0780-the-enrolled-device.md)).
     Its credential alone shows "Enter code" and makes `desk.claim`; it reads no Person, document
     or session.
  2. A person on the staff with **`agreements:desk`** starts a **desk signing session**
     (`agreement.desk.start { personId, deviceId, dependantIds? }`, `actors: ["human"]`, risk
     `write`) for one named Person on the device they choose, listing the live children they
     sign for. The host answers an 8-character code from an alphabet with no look-alikes, single
     use, good for 2 minutes until claimed, kept only as its HMAC under `DESK_SECRET`.
- **`agreements:desk`** is a core permission: admins hold it, a human admin grants it, and it is
  the one core permission grantable to an account holding a pack role (`FIXED_ROLE_GRANTABLE`;
  ADR 0600 amended), so a coach at the desk may start a session. It shows the titles of what the
  Person and their children have due (`agreement.desk.prepare`), people by name only
  (`agreement.desk.find`), the signing devices (`agreement.desk.devices`), the session's state
  (`agreement.desk.get`) and ends it (`agreement.desk.end`), and nothing else. It records no
  acceptance: the member signs.
- **Refused at the start**: a Person in the Trash; a minor for themselves (start it for their
  parent or guardian); a signer with no address (the copy goes there every time); a child whose
  link is not live; a device that is not an active signing device. The address the copy goes to
  (the customer account's sign-in address, else the Person's primary) is pinned on the session.
- **The claim** (`desk.claim { code }`) binds the session to the tablet and sets a session token
  (256 bits, its HMAC kept) in its own cookie. Every claim rotates the device's credential; a
  retry within 60 seconds with the old credential and the code gets the same new credential and
  the same token (both are derived from the old credential under the secret, so the host stores
  neither in the clear). A claim from another device than the one chosen ends the session
  (`wrong_device`), and so does a wrong code typed on the chosen device while the session waits
  (`failed_claim`); staff see which on their screen. Five wrong codes from one device in a minute
  lock it for five minutes. A claim ends any other session open on the device.
- **The token reaches exactly five calls**: `desk.claim`, `desk.documents`, `desk.accept`,
  `desk.heartbeat` and `desk.finish`, each on that one session, with the credential of the device
  it was bound to. They are core operations open to the **public** audience but marked
  **`deskOnly`** (a new operation option, ADR 0402 amended below): reached only from the desk
  origin's own handler, which passes the request's cookies in `ctx.desk.request`, never in an
  input; every other caller (the HTTP surface, the client-app binding) is told no such operation
  exists, they are left out of the HTTP contract and the manifest, and a desk request reaches no
  other operation. `open-operations.json` lists them, marked `deskOnly`.
- **Limits from the session row**, whatever the page does: 3 minutes since the last activity, 20
  since the claim. A call after either is refused and ends the session on the server. Reading
  counts: the page sends `desk.heartbeat` while the person touches or scrolls, at most every 30
  seconds, and a heartbeat less than 20 seconds after the last does not extend it.
- **What the tablet shows**: the business's name, "Documents for [given name]" (and each child's
  given name), each due document's version in the Agree block's web skin, where the copy goes
  masked (`s•••@e•••.com`), then "All done: please hand the device back". `desk.documents` serves
  only what is due now for the session's Person and listed children still linked; `desk.accept`
  refuses any other version or Person.
- **The record** is the member's own acceptance (`by: "self"`, or `"guardian"` for a child with the
  signer as agent), `channel: "desk"`, `account_id` null and `desk_session_id` set. Migration 0858
  holds every writer to it: a desk acceptance must name a claimed, open session and its Person (or
  a child it lists, with the signer as agent), and no other channel names a session. Every screen
  and the PDF say "Agreed at the desk on the device enrolled as [name] by [admin] on [date];
  session started by [staff] at [time]": never "in person", never paper. The copy says "Version
  [n] of [document] was accepted for you at [business]'s desk, on the device enrolled as [name],
  in a session started by [staff] at [time]. If this was not you, reply …", and claims no more.
- **Marks, not alerts** (`agreements/desk-marks.ts`), worked out when the Acceptances list or the
  Person tab is read: the primary address changed in the 30 days before or after (from the audit,
  any path, saying who and with which operation), the Person created within the day before, and a
  staff account's address (compared by mailbox). The Acceptances list filters by "at the desk", by
  mark, by device and by who started the session.
- **The desk origin** is its own hostname for the same Worker (`desk.` before the host's,
  `DESK_HOSTNAME`, set by `cos deploy` with the custom domain). Its handler
  (`apps/app/src/server/http/desk.ts`) serves the two pages (`/desk`, `/enrol`, rendered by
  TanStack Start, never through MCP's wrapper) and `POST /api/desk/<call>`, and nothing else; the
  staff origin answers the desk's paths as not found. Both cookies are `__Host-` (no Domain, path
  /), `HttpOnly`, `Secure`, `SameSite=Strict`, never in a URL or an answer's body. Every desk call
  must carry the desk origin's `Origin` and JSON, is refused with a staff (or customer) session,
  and is limited per address (`DESK_RATE_LIMIT`). Answers are never framed or cached and send no
  referrer. A deployment without the hostname or the secret has no desk mode at all.
- **Staff screens the stage 47 way**: Sign at the desk is a panel on the Person page's Agreements
  tab, and a **core screen** that `screens.mine` lists by stage 47's rule (a person who could call
  its gate, `agreement.desk.start` and `agreement.desk.find`), so a coach granted `agreements:desk`
  finds it in their small shell (ADR 0660 amended below).
- **Erase and merge** (ADR 0646): erase ends a Person's open session and keeps every session of
  theirs detached (no Person, no pinned address) with the acceptances it made, and takes them off
  a session's list of children; merge moves both to the survivor. A session is never deleted.
- **The AI never**: every staff operation here is `actors: ["human"]` and not on MCP; the desk
  calls are the desk origin's handler's only.

## Consequences
- The emailed copy is the deterrent against staff signing for a member; it is not proof that the
  member was there, and nothing says it is. Whether a desk acceptance is enough evidence is the
  business's question for its lawyer (stage 44's list, item 12).
- **Not built here**, and why: a second copy to the **previous address** when it changed in the 30
  days before. The copy machinery is one recipient per acceptance by design (the copy row's key,
  its states, the gatekeeper's one-recipient agreement rule and the erase scrub are all per row);
  a second send needs its own row, key and scrub, in the erase-completeness area. Until then the
  "address changed recently" mark shows the change on the list. A QR code on the staff screen
  (the code is typed) is not built either.
- The rotation chain keeps one previous credential: a credential two rotations old is refused as
  not enrolled rather than revoking the device as a clone.

## Amended
- **ADR 0402** (2026-11-24): an operation open to the public may be `deskOnly`: open only to the
  desk origin's own handler, left out of the HTTP contract and manifest, and listed in
  `open-operations.json` as such. It must also be `hostInternal`.
- **ADR 0600** (2026-11-24): core declares `agreements:desk` grantable to a fixed-role account
  (`FIXED_ROLE_GRANTABLE`); a grant of it opens exactly the core operations whose permission it
  is. No other core permission is.
- **ADR 0660** (2026-11-24): `screens.mine` also lists core's own screens (`pack: "core"`,
  `CORE_SCREENS`), each gated by core operations as a pack's by its tools; the admin holds their
  components.
