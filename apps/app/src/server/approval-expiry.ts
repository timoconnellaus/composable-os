// How many days a pending action waits for a decision: APPROVAL_EXPIRY_DAYS when it is a positive
// whole number, else core's default.
import { DEFAULT_APPROVAL_EXPIRY_DAYS } from "@composable-os/core";

export function approvalExpiryDays(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_APPROVAL_EXPIRY_DAYS;
}
