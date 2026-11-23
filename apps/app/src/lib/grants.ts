// What the Users page saves for an account's grants (ADRs 0449, 0600): only those it may hold now.
// A stored grant that no longer applies (its pack was removed, or a core one on a fixed role's
// account) would make every save fail with invalid_input, so it is split out, shown to the admin,
// and dropped from what is sent.

/** The stored grants the account may hold (`held`) and those that no longer apply (`stale`). */
export function splitGrants(
  stored: readonly string[],
  allowed: readonly string[],
): { held: string[]; stale: string[] } {
  const ok = new Set(allowed);
  return {
    held: stored.filter((p) => ok.has(p)),
    stale: stored.filter((p) => !ok.has(p)),
  };
}

/** The list to send when one permission is ticked or unticked: never a stale grant. */
export function toggledGrants(
  stored: readonly string[],
  allowed: readonly string[],
  permission: string,
  on: boolean,
): string[] {
  const { held } = splitGrants(stored, allowed);
  const rest = held.filter((p) => p !== permission);
  return on && allowed.includes(permission) ? [...rest, permission] : rest;
}
