# ADR 0781: A device as a caller: the `device` audience and device roles

Status: accepted, 2026-11-24 (stage 51, build step 2). Amends ADRs
[0402](0402-staff-and-customers.md) (audiences) and [0436](0436-pack-roles-and-the-door-role.md)
(pack roles, `ctx.caller`). Builds on [ADR 0780](0780-the-enrolled-device.md) (the enrolled
device) and [ADR 0649](0649-signing-at-the-desk.md) (the desk origin). Spec:
[stage 51](../stages/51-kiosk-check-in.md#the-device-role).

## Context
Stage 51's check-in tablet is the business's own device, enrolled by an admin, signed in as
nobody, and able to do almost nothing: check a person in. It is not staff (no person is signed in,
and "who ticked it" must not name someone who was not there), not a customer (it reads nobody's
own records), and not the public (every call needs an enrolled credential). The three audiences
had no place for it, `StartedBy` could not name it, and a pack role (ADR 0436) is held only by a
user account. Step 1 (ADR 0780) built the device record with a `role` use the host refused until
a pack could declare one.

## Decision

**A fourth audience, `device`.** An operation (core or a pack's tool) may declare
`audiences: ["device"]`, and then nobody else: the registry refuses `device` beside another
audience, and beside `deskOnly` or `toolOnly`. It is an open operation (risk `read` or `write`,
listed in `open-operations.json`, a reviewed addition), and is left out of the HTTP contract and
the staff surfaces (MCP, the assistant, automations): only the desk origin's handler reaches it.

**A device is a caller.** `DevicePrincipal { kind: "device", deviceId, name, role }`. The desk
origin's handler (`apps/app/src/server/http/desk.ts`) routes `device.heartbeat` and
`x.<pack>.<tool>` to the pipeline as `{ kind: "device" }` with the request, and says nothing
more. The pipeline's **device check** (`packages/core/src/devices/caller.ts`), before the input
is looked at:
1. a device's call comes only with the desk origin's request, never from inside a tool's run, and
   never for a `deskOnly` operation (unknown operation otherwise);
2. the credential is an enrolled, unrevoked device's (`resolveDevice`: rotation, the grace
   window, clones and lapsing as for every desk call); a browser that is not one is "not
   enrolled";
3. the device's use is `role`, and its role is one an installed, active, shipped pack declares now
   (`loadDeviceRole`, one read by primary key);
4. the role reaches the operation (`deviceRoleReaches`): `device.heartbeat`, or a tool of the
   role's own pack open to `device` only whose permission the role lists.
A refusal at 3 or 4 is `forbidden` (rule `device_role`) and audited as that device's, its input not
kept. A call that passes is audited (writes) or counted (reads) with actor `device` and the
device's id; what records it on the device (last seen, a rotation) goes in the call's own batch.
Calls are limited per device and operation, beside the desk origin's limit per address. The seam
gives a device principal nothing (an unknown principal's scope is none), and it places no order.

**Device roles.** A shipped pack declares `deviceRoles` in its manifest (`DeviceRoleSpec`):
`{ label, description, permissions, screen: { block, export } }`. The contract check refuses a
device role naming another pack's permission or a permission any tool open to staff, customers or
the public names; a permission a staff role holds, or that is grantable or restricted; a role with
no permission; a screen that is not a web block of the same pack. It refuses a tool open to
`device` that is open to anyone else, names no permission, names one no device role holds, is a
record action, or lifts a role's limits; and (as for any open tool) one that is `humanOnly`,
`personApproves`, `anyStaff`, has a `corePermission`, or a risk above `write`. A runtime
extension's device roles are refused by `cos ext check` and install (`outside_audience`), and its
tools' audiences and permissions are ignored at run time, as before.

**`ctx.caller` names the device**: `StartedBy` gains `{ kind: "device", deviceId, name }`, set by
the host from the device the pipeline resolved. The tool's own operation calls run **as the
extension**, as a staff caller's do (ADR 0436), not through the outside path: a device reads
nothing itself, and its tools read as the extension and return only what their outputs declare.
Nothing in the run is "me" (`calledBy` is not set), and its writes stand as the host's (a shipped
pack's code, no person's given values).

**`device.heartbeat`** (`device` audience, a read): answers the device's own name and role, so
its screen knows what it is for; the pipeline records it as seen, so a tablet in use does not
lapse (ADR 0780's 30 days).

## Why
- One check, in the pipeline, from the rows: the adapter says only "a device call", as it says
  nothing of a staff account's pack role (ADR 0436). A forged principal cannot name a device or a
  role, and a device revoked, lapsed or given another use is held to it at its next call.
- A fourth audience rather than a public operation with a credential check in each tool: the
  audience check refuses every other caller before anything runs, and the registry walk can prove
  what a device reaches.
- Running the tool's calls as the extension keeps one model for "a narrow caller, a reviewed tool
  that reads broadly and answers little" (the desk's tools under `bookings:desk`, ADR 0600). A
  device principal reaching records through the seam would need a scope of its own for no gain.

## Proof
`packages/core/test/device-caller.test.ts`: a fixture pack declaring two device roles; a device
enrolled for one calls its heartbeat and its role's two tools (`ctx.caller` is the device, the
write audited as its own), and every other operation in the registry (core, the release's packs'
tools, the fixture's other role's tool) is refused `unknown_operation` or `forbidden`. Loosened
(the role check skipped), the walk lets a fourth operation through and fails. A signing device
calls none of them, and a check-in device claims no signing session; a browser without a
credential, a revoked device, a call without the desk request or from inside a tool's run, staff
(any actor), a customer and the public are refused; staff surfaces list none of them; a disabled
or runtime pack's role holds nothing; check and install refuse a runtime extension's device role.
`apps/runner/test/device-tool.test.ts`: in the real sandbox the tool sees `ctx.caller` as the
device and its `record.create` is the extension's. `apps/app/test/desk.test.ts`: the desk origin
routes a device's calls, with its Origin and no-session checks; none is on the HTTP surface.
`packages/sdk/test/device-roles.test.ts`: the contract check.

## Consequences
- The device check adds, on a device's call only, the device's row (one read by its credential
  hashes) and the role's pack row (one read by primary key). Nobody else's call changes.
- `audit.list` may filter by actor `device`; the staff API contract changed by that one value.
- Step 4 declares Bookings' `bookings.checkin` role and its tools (`doorNow`, `checkInHere`);
  step 6 serves the device role's screen on the desk origin. A till (stage 50) is still refused
  at enrolment and holds no device role.
