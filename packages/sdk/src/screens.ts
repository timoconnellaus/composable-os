// What decides a shipped pack's staff screens (stage 47, ADR 0660), as one string: the screens it
// declares and everything their gates are judged by (each gate tool's risk, audiences, permissions
// and `humanOnly`, the pack's restricted and grantable permissions and its roles). The admin's
// build computes it from each pack in the repository (screens-plugin.ts) and hands the host the
// list; `screens.mine` lists a pack's screens only when the installed row's manifest gives the same
// string. So a row that holds a pack's id with another manifest (an org's own extension taking an
// unlisted pack's id, a copy whose gate tools say less) borrows none of the pack's built screens.
import type { ExtensionManifest } from "./manifest.ts";

/** JSON with object keys sorted, so the same manifest gives the same string. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();

/** The gate fingerprint of a manifest's screens, or null when it declares none. */
export function screenGateFingerprint(m: Partial<ExtensionManifest>): string | null {
  const screens = m.screens ?? {};
  if (!Object.keys(screens).length) return null;
  const toolNames = new Set(Object.values(screens).flatMap((s) => s.opens ?? []));
  const tools = Object.fromEntries(
    [...toolNames].sort().map((name) => {
      const tool = m.tools?.[name];
      return [
        name,
        tool
          ? {
              risk: tool.risk,
              audiences: sorted(tool.audiences ?? ["staff"]),
              permission: sorted(
                tool.permission === undefined
                  ? []
                  : typeof tool.permission === "string"
                    ? [tool.permission]
                    : tool.permission,
              ),
              humanOnly: tool.humanOnly === true,
              grantLiftsRoleLimits: tool.grantLiftsRoleLimits === true,
              // ADR 0652: only when set, so a pack declaring neither keeps its fingerprint.
              ...(tool.anyStaff ? { anyStaff: true } : {}),
              ...(tool.corePermission ? { corePermission: tool.corePermission } : {}),
            }
          : null,
      ];
    }),
  );
  return canonical({
    id: m.id,
    screens: Object.fromEntries(
      Object.entries(screens).map(([key, s]) => [
        key,
        {
          label: s.label,
          block: s.block,
          export: s.export,
          nav: s.nav ? { group: s.nav.group, order: s.nav.order ?? null } : null,
          opens: [...(s.opens ?? [])],
          writes: [...(s.writes ?? [])],
          record: s.record ? { object: s.record.object, as: s.record.as } : null,
        },
      ]),
    ),
    tools,
    restricted: sorted(m.restricted),
    grantable: sorted(m.grantable),
    roles: Object.fromEntries(
      Object.entries(m.roles ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, r]) => [
          name,
          {
            permissions: sorted(r.permissions),
            read: sorted(r.read),
            today: r.today ?? null,
            // Left out when absent, so a role without it keeps its fingerprint (ADR 0889).
            looksAfter: r.looksAfter,
            // Left out when absent too (ADR 0755).
            mine: r.mine,
          },
        ]),
    ),
  });
}
