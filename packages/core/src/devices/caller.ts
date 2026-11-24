// A device as a caller (stage 51 step 2, ADR 0781): the pipeline's device check.
//
// A call from an enrolled device arrives only from the desk origin's own handler, which says no
// more than `{ kind: "device" }` and passes the request (its credential cookie). Here the host
// decides who it is and what it may do, from the rows and never from the adapter:
//   - the credential is an enrolled, unrevoked device's (`resolveDevice`: rotation, the grace
//     window, clones and lapsing as for every desk call, ADR 0780);
//   - the device's use is `role`: a signing tablet or a till holds no device role, so it calls
//     none of these operations;
//   - its device role is declared now by an installed, active, shipped pack (`loadDeviceRole`);
//   - the operation is one the role reaches (`deviceRoleReaches`): its own heartbeat, or a tool
//     of the role's pack, open to `device` only, whose permission the role lists.
// Everything else is refused before the input is looked at.
import type { Compilable } from "kysely";
import { ForbiddenError } from "../errors.ts";
import type { AnyOperation } from "../operation.ts";
import { deviceRoleReaches, type HeldDeviceRole, loadDeviceRole } from "../pack-roles.ts";
import type { DevicePrincipal } from "../principals.ts";
import { type DeskHost, type DeskRequest, notEnrolled, resolveDevice } from "./devices.ts";

type Db = Parameters<typeof resolveDevice>[0];

export interface DeviceCall {
  principal: DevicePrincipal;
  role: HeldDeviceRole;
  /** What records this call on the device (last seen, a rotation), for the call's own batch. */
  statements: Compilable[];
}

/** What a device is told for an operation outside its role, whatever the reason. */
export function outsideRole(operation: string): ForbiddenError {
  return new ForbiddenError("This device's role does not include that.", {
    operation,
    rule: "device_role",
  });
}

/** A call outside the device's role: refused, and audited as that device's. */
export interface DeviceRefusal {
  refused: ForbiddenError;
  deviceId: string;
}

/**
 * The enrolled device a desk request comes from, as a caller of `op`; or, for an enrolled device
 * whose role does not reach `op` (or that holds no device role), the refusal to audit and throw.
 * A browser that is not an enrolled device (no credential, revoked, lapsed, a clone) throws
 * `notEnrolled`.
 */
export async function resolveDeviceCall(
  db: Db,
  desk: DeskHost | undefined,
  request: DeskRequest | undefined,
  op: AnyOperation,
  now: string,
): Promise<DeviceCall | DeviceRefusal> {
  if (!desk || !request) throw notEnrolled();
  const resolved = await resolveDevice(db, desk, request, now);
  const device = resolved.device;
  // A signing tablet (stage 44) or a till holds no device role: it calls none of these.
  if (device.use !== "role" || !device.role) {
    return { refused: outsideRole(op.name), deviceId: device.id };
  }
  const role = await loadDeviceRole(db, device.role);
  if (!role || !deviceRoleReaches(role, op)) {
    return { refused: outsideRole(op.name), deviceId: device.id };
  }
  return {
    principal: Object.freeze({
      kind: "device",
      deviceId: device.id,
      name: device.name,
      role: role.name,
    }),
    role,
    statements: resolved.statements,
  };
}
