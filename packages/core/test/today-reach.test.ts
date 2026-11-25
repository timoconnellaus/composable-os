// Stage 60 (ADR 0874): every shipped pack's Today items crossed with every shipped pack role, so
// that a fixed-role account's Today holds nothing its own tools would not show. For each pair the
// item is hidden from the role, or every view it reads is of an object the role reads and is not
// limited to some People, and an object limited to today is read in today's window with no
// comparison; its rows are given only over objects the role reads. Checked against the real
// packs' manifests, so it checks each item the moment a pack declares one (step 4), and against
// items made here over each role's own objects and the base ones, so the check is live today.

import { env } from "cloudflare:workers";
import { toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { viewOf } from "../src/extensions/naming.ts";
import { toolOperation } from "../src/extensions/tools.ts";
import { schemaObjectNames, tokenize, validateReadOnlySql } from "../src/operations/query.ts";
import { loadStaffRights, type StaffRights } from "../src/pack-roles.ts";
import { type Viewer, windowsOf } from "../src/today/items.ts";
import { type PackItem, visiblePackItem } from "../src/today/pack.ts";
import { createUser, db } from "./helpers.ts";
import { releasePackExtensions } from "./release-packs.ts";

const NOW = new Date().toISOString();
const manifests = releasePackExtensions.map((e) => toManifest(e));
type Manifest = (typeof manifests)[number];

/** Every view the release's objects make, and the base ones already in the database. */
let names: Set<string>;
const view = (object: string) => {
  try {
    return viewOf(object).toLowerCase();
  } catch {
    return null;
  }
};

beforeAll(async () => {
  names = await schemaObjectNames(db.query);
  const owner = await createUser("admin");
  for (const m of manifests) {
    for (const object of Object.keys(m.objects)) {
      const v = view(`${m.id}.${object}`);
      if (v) names.add(v);
    }
    await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(m.id).run();
    await env.DB.prepare(
      `INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at)
       VALUES (?, 'shipped', 'active', ?, 'test', ?, ?, ?, ?)`,
    )
      .bind(m.id, m.version, JSON.stringify(m), owner.id, NOW, NOW)
      .run();
  }
});

/** A viewer holding the pack role `name`, as `today.get` builds one. */
async function viewerOf(name: string): Promise<{ viewer: Viewer; rights: StaffRights }> {
  const user = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?").bind(name, user.id).run();
  const rights = await loadStaffRights(db.query, user.id);
  if (!rights.packRole) throw new Error(`no role ${name}`);
  const viewer: Viewer = {
    ctx: { user, actor: "human", now: NOW } as never,
    rights,
    person: true,
    zone: "UTC",
    windows: windowsOf(NOW, "UTC"),
    packs: manifests.map((manifest) => ({ id: manifest.id, manifest })),
    rosterer: async () => false,
  };
  return { viewer, rights };
}

const lower = (views: readonly string[]) => views.map((v) => v.toLowerCase());
const bindsToday = (sql: string) => {
  const params = new Set(
    tokenize(sql)
      .filter((t) => t.kind === "param")
      .map((t) => t.text.slice(1).toLowerCase()),
  );
  return params.has("today_from") && params.has("today_to");
};
const viewsRead = (sql: string) =>
  lower(validateReadOnlySql(sql.replace(/:(today_from|today_to|now)\b/gi, "?"), names).views);

/** The invariant, written apart from the rule it checks. */
function checkPair(viewer: Viewer, item: PackItem): string | null {
  const role = viewer.rights.packRole;
  if (!role) return "no role";
  const visible = visiblePackItem(viewer, item, names);
  if (!visible) return null;
  const reads = new Set(role.read.flatMap((o) => view(o) ?? []));
  const limited = new Set(
    [...Object.keys(role.looksAfter?.reach ?? {}), ...Object.keys(role.mine ?? {})].flatMap(
      (o) => view(o) ?? [],
    ),
  );
  const todays = new Set(Object.keys(role.today ?? {}).flatMap((o) => view(o) ?? []));
  const value = viewsRead(item.spec.sql);
  const where = `${role.name} sees ${item.key}`;
  if (value.some((v) => !reads.has(v))) return `${where}, reading a view it does not read`;
  if (value.some((v) => limited.has(v))) return `${where}, reading a person-limited view`;
  if (value.some((v) => todays.has(v))) {
    if (visible.compare) return `${where} with another day's figure`;
    if (!bindsToday(item.spec.sql)) return `${where} outside today's window`;
  }
  if (visible.rows) {
    const rows = item.spec.rows;
    if (!rows) return `${where}: rows it does not declare`;
    if (!role.read.includes(rows.record.object)) return `${where}'s rows of what it does not read`;
    const rowViews = viewsRead(rows.sql);
    if (rowViews.some((v) => !reads.has(v) || limited.has(v)))
      return `${where}'s rows, over views beyond it`;
    if (rowViews.some((v) => todays.has(v)) && !bindsToday(rows.sql)) {
      return `${where}'s rows outside today's window`;
    }
  }
  return null;
}

/** Every shipped pack role, as `<pack>.<role>`. */
const ROLES = manifests.flatMap((m) =>
  Object.keys(m.roles ?? {}).map((r) => ({ m, name: `${m.id}.${r}` })),
);

/** A tool of the role's pack its role opens (none every staff account may call). */
function toolOfRole(m: Manifest, permissions: readonly string[]): string | null {
  for (const [name, tool] of Object.entries(m.tools ?? {})) {
    const op = toolOperation(m, name, tool, "shipped");
    if (op.packAnyStaff) continue;
    if ((op.packPermissions ?? []).some((p) => permissions.includes(p))) return name;
  }
  return null;
}

describe("a shipped pack role's Today holds nothing beyond its reach (ADR 0874)", () => {
  it("every shipped pack's declared item, crossed with every shipped pack role", async () => {
    const problems: string[] = [];
    let pairs = 0;
    for (const { name } of ROLES) {
      const { viewer } = await viewerOf(name);
      for (const m of manifests) {
        for (const [key, spec] of Object.entries(m.todayItems ?? {})) {
          pairs += 1;
          const problem = checkPair(viewer, {
            key: `${m.id}.${key}`,
            pack: m.id,
            name: key,
            manifest: m,
            spec,
          });
          if (problem) problems.push(problem);
        }
      }
    }
    expect(problems).toEqual([]);
    // Zero until a pack declares items (stage 60 step 4); every pair is checked from then on.
    expect(pairs).toBe(
      ROLES.length * manifests.reduce((n, m) => n + Object.keys(m.todayItems ?? {}).length, 0),
    );
  });

  it("items over each role's own objects and the base ones, opened by its own tool", async () => {
    const problems: string[] = [];
    let visible = 0;
    for (const { m, name } of ROLES) {
      const { viewer, rights } = await viewerOf(name);
      const opener = toolOfRole(m, rights.packRole?.permissions ?? []);
      if (!opener) continue;
      const objects = [
        ...Object.keys(m.objects).map((o) => `${m.id}.${o}`),
        "person",
        "organisation",
      ];
      for (const object of objects) {
        const v = view(object);
        if (!v || !names.has(v)) continue;
        for (const [label, sql, compare] of [
          [
            "today",
            `SELECT count(*) AS value FROM ${v} t WHERE t.created_at >= :today_from AND t.created_at < :today_to`,
            "yesterday",
          ],
          ["ever", `SELECT count(*) AS value FROM ${v} t`, "lastWeek"],
        ] as const) {
          const spec = {
            label,
            format: "count",
            sql,
            compare,
            opens: [opener],
            rows: {
              sql: `SELECT t.id AS label, t.id AS id FROM ${v} t LIMIT 50`,
              label: "label",
              record: { object, id: "id" },
            },
          } as unknown as PackItem["spec"];
          const item = { key: `${m.id}.${label}`, pack: m.id, name: label, manifest: m, spec };
          if (visiblePackItem(viewer, item, names)) visible += 1;
          const problem = checkPair(viewer, item);
          if (problem) problems.push(`${problem} (${object}, ${label})`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Something is shown (a role reading its own objects), so the check is not vacuous.
    expect(visible).toBeGreaterThan(0);
  });
});
