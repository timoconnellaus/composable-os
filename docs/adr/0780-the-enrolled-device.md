# ADR 0780: The enrolled device: one record, one use, a credential that rotates

Status: accepted, 2026-11-24 (stage 51, build step 1, built with stage 44's step 6). Builds on
stage 44's design of the desk tablet ([spec](../stages/44-agreements.md#signing-at-the-desk-decision-22)),
generalised as stage 51's spec says ([The enrolled device](../stages/51-kiosk-check-in.md#the-enrolled-device-the-shared-piece)).
Used by [ADR 0649](0649-signing-at-the-desk.md) (signing at the desk).

## Context
Desk signing (stage 44), the check-in tablet (stage 51) and the till (stage 50) each need a device
that is the business's own: enrolled by an admin, holding no person's sign-in, revoked when lost.
Two enrolment flows would be two attack surfaces and two Settings pages. Stage 44's design
(`core_agreement_desk_device`, never built) becomes one record for every use.

## Decision
- **`core_device`** (`dev_…`, migration 1130): a name, one **use** (`signing`, `role` with the
  device role it holds, or `till`), who enrolled it and when, when it was claimed and last seen,
  the browser and network address at the claim and at each rotation, the flags a change raises,
  the wrong-code lock-out, and who revoked it, when and why (`admin`, `clone`, `lapsed`). Not a
  record: no `rec_*` view. Never deleted (it is evidence for the desk acceptances made on it); a
  revoked device stays revoked and holds no credential again (its triggers).
- **Enrolling is a human admin's act**: `device.enrol { name, use, role? }`, `device.setUse` and
  `device.revoke` need `users:manage` (which no grant gives) and `actors: ["human"]`; every admin
  is told in the host at once. `device.enrol` answers a single-use **enrolment code** (10
  characters, 10 minutes, kept as its HMAC) and where to type it: the desk origin's `/enrol`.
- **`device.claim { code }`** on the desk origin (public, `deskOnly`, ADR 0649) sets the **device
  credential**: 256 random bits in the `__Host-cos-desk-device` cookie (`HttpOnly`, `Secure`,
  `SameSite=Strict`), kept as its HMAC under `DESK_SECRET`. A browser that is already an enrolled
  device is refused (an admin changes its use instead).
- **Rotation**: the first call more than 24 hours after the last rotation, and every call that
  asks (a signing claim), gets a new credential in its answer, derived from the presented one
  under the secret. The credential rotated away is accepted for 60 seconds (the grace window) and
  gets the same new one, so a lost answer or calls made at once do not lock the tablet out.
- **Clones and lapsing**: a credential rotated away and presented after the grace window means two
  browsers hold it: the host revokes the device (`clone`), ends any session on it and tells every
  admin. A device with no call for 30 days lapses (`lapsed`); an admin enrols it again.
- **Revoking or changing its use** ends any open signing session on it in the same statement
  (migration 1130's triggers), whatever wrote the change.
- **What the credential alone may do**, by use: `signing`, show Enter code and claim a session
  (ADR 0649); `role`, its device role's tools (stage 51 step 2, not built: no pack declares a
  device role yet, so the host refuses the `role` use until one does); `till`, nothing (stage 50,
  not built: refused at enrolment for now).
- **Settings → Devices** lists every device of every use, with its state, who enrolled it, when
  it was last seen, its browser and network and the changes flagged, a lock-out, and revoke and
  change of use.
- **Every device call** comes through the desk origin's handler (ADR 0649): its `Origin`, no staff
  session, a per-address limit.

## Consequences
- The browser and the address describe the business's own tablet and premises, not a member's
  device (stage 44, decision 3), and are shown to admins only.
- A deployment with no desk hostname (workers.dev) or no `DESK_SECRET` enrols no device.
- Stage 51's step 2 adds the device as a caller (`ctx.caller`, the `device` audience) and device
  roles; step 1 here adds only the record, the uses and Settings → Devices. `device.heartbeat`
  (for a device role) comes with step 2: a signing device needs none.

**Amended 2026-11-24, after the review of PR #390:**
- **Rotation is confirmed by use.** The host issues the next credential (`pending_credential_hash`)
  and keeps the current one good until the device presents the next; until then every answer
  re-issues the same next one (it is derived from the current). Only then is the old one rotated
  away: accepted for 60 seconds more (calls made at once) and, presented after that, revoking the
  device as a clone. An answer lost on premises Wi-Fi no longer makes a healthy tablet look copied.
- **Lapsed is lapsed everywhere**: a device with no call for 30 days is "not enrolled" to
  `desk.status`, is not offered or accepted for a desk session, and shows as `lapsed` on Settings →
  Devices; its next call revokes it.
- **Two browsers claiming one enrolment code at once**: the one that lost is refused (a guard row,
  `core_device_guard`, fails its batch unless the device holds its credential).
- **`device.list`** is a person's (`actors: ["human"]`): a device's browser and address are for an
  admin who is a person.
