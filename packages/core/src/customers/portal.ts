// Which sections of My account a signed-in customer has (stage 48 step 5, ADR 0710). The base
// sections always (Payment method only for someone who pays a subscription); a shipped pack's
// section when the pack is installed and active and the caller, or a child linked to them where
// the object opens to guardians, holds a record of one of the objects its `portal` declaration
// names in `has`, read through the seam (`ownReadSource`: their own records, never what is shared
// with every signed-in customer). No pack code runs: the declaration is the pack's manifest, and
// whether a section shows is a count of rows. The client renders the answer.
//
// Cost: two statements whatever is installed: the installed shipped packs' `portal` declarations,
// and one statement of EXISTS checks (one row, a column each) over every named object and the
// subscriptions the caller pays. The checks are split over more statements only past
// `CHECKS_PER_STATEMENT`, which the packs in the repository (seven objects) do not reach.
import type { PortalSectionManifest } from "@composable-os/sdk";
import { type RawBuilder, sql } from "kysely";
import { OperationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { ownReadSource } from "../visibility/index.ts";

/**
 * The base sections and where they sit (the client's `BASE_SECTIONS` holds the same keys, labels
 * and orders): a pack's come first, at 1 to 59.
 */
export const BASE_PORTAL_SECTIONS = [
  { key: "orders", label: "Orders", order: 60 },
  { key: "agreements", label: "Agreements", order: 70 },
  { key: "family", label: "Family", order: 80 },
  { key: "payment", label: "Payment method", order: 85 },
  { key: "details", label: "Your details", order: 90 },
  { key: "contact", label: "Contact preferences", order: 92 },
  { key: "devices", label: "Sign-in and devices", order: 95 },
  // Last, for every customer: deleting the account from their own side (stage 48 step 7).
  { key: "delete", label: "Delete my account", order: 99 },
] as const;

export interface PortalSection {
  /** A base section's key (`orders`), or a pack's as `<pack>.<key>` (`memberships.memberships`). */
  key: string;
  /** The pack it is from; null for a base section. */
  pack: string | null;
  label: string;
  order: number;
  /** The blocks that draw it, from the pack's declaration; null for a base section. */
  web: { block: string; export: string } | null;
  native: { block: string; export: string } | null;
}

/**
 * Each check binds at most three values (the caller's id twice and the link's kind, for an object
 * that opens to guardians): 25 stay well under 100 bound variables.
 */
const CHECKS_PER_STATEMENT = 25;

/** Packs whose installed declaration could not be read, said once each per isolate. */
const unreadable = new Set<string>();

export async function portalOf(
  ctx: HandlerContext,
): Promise<{ sections: PortalSection[]; paysSubscription: boolean }> {
  if (ctx.principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  const me = ctx.principal.personId;
  // Shipped packs only: a runtime extension's `portal` is refused at check and install, and
  // ignored here.
  const { rows } = await sql<{ id: string; portal: string }>`SELECT id,
      json_extract(manifest, '$.portal') AS portal
    FROM core_extensions
    WHERE status = 'active' AND source = 'shipped'
      AND json_extract(manifest, '$.portal') IS NOT NULL
    ORDER BY id`.execute(ctx.db);

  const candidates: { pack: string; key: string; section: PortalSectionManifest }[] = [];
  for (const row of rows) {
    try {
      const declared = JSON.parse(row.portal) as Record<string, PortalSectionManifest>;
      for (const [key, section] of Object.entries(declared)) {
        if (Array.isArray(section?.has) && section.has.length) {
          candidates.push({ pack: row.id, key, section });
        }
      }
    } catch {
      // One unreadable row never takes the others' sections away: it adds nothing.
      if (!unreadable.has(row.id)) {
        unreadable.add(row.id);
        console.warn(`me.portal: the installed portal declaration of ${row.id} could not be read`);
      }
    }
  }

  // One check per object named, each read through the seam; the subscriptions the caller pays
  // last (ADR 0487: a subscription is its payer's).
  const objects = [
    ...new Set(
      candidates.flatMap((c) => c.section.has.filter((name) => name.startsWith(`${c.pack}.`))),
    ),
  ];
  const checks: { name: string; query: RawBuilder<unknown> }[] = [];
  for (const name of objects) {
    const definition = getObject(name);
    // Their own records only (and a child's where the object opens to guardians): an object
    // without a customer declaration holds none of theirs.
    if (!definition?.customer) continue;
    const source = ownReadSource(ctx, definition, "held");
    checks.push({ name, query: sql`EXISTS (SELECT 1 FROM ${source})` });
  }
  checks.push({
    name: "",
    query: sql`EXISTS (SELECT 1 FROM core_subscription
      WHERE payer_person_id = ${me} AND state NOT IN ('ended', 'expired'))`,
  });
  const held = new Set<string>();
  let paysSubscription = false;
  for (let at = 0; at < checks.length; at += CHECKS_PER_STATEMENT) {
    const part = checks.slice(at, at + CHECKS_PER_STATEMENT);
    // One row of EXISTS columns, not a compound SELECT: D1 limits a compound's terms.
    const row = (
      await sql<Record<string, number>>`SELECT ${sql.join(
        part.map((check, i) => sql`${check.query} AS ${sql.ref(`c${i}`)}`),
      )}`.execute(ctx.db)
    ).rows[0];
    part.forEach((check, i) => {
      if (!row?.[`c${i}`]) return;
      if (check.name === "") paysSubscription = true;
      else held.add(check.name);
    });
  }

  const sections: PortalSection[] = BASE_PORTAL_SECTIONS.filter(
    (s) => s.key !== "payment" || paysSubscription,
  ).map((s) => ({ ...s, pack: null, web: null, native: null }));
  for (const { pack, key, section } of candidates) {
    if (!section.has.some((name) => held.has(name))) continue;
    sections.push({
      key: `${pack}.${key}`,
      pack,
      label: section.label,
      order: section.order,
      web: section.web ? { block: section.web.block, export: section.web.export } : null,
      native: section.native
        ? { block: section.native.block, export: section.native.export }
        : null,
    });
  }
  sections.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { sections, paysSubscription };
}
