// Accounting sync's settings and mapping (stage 61 step 2). Core speaks one accounting contract
// (`packages/gatekeeper-accounting`, ADR 0880) and never names a system: the books are an org
// connection of a gatekeeper the catalogue marks `implements: "accounting"`, and a resource bound
// on it. One settings row (`core_accounting_settings`, id 1); the mapping is per connection, since
// its refs are the books' own.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import { CATALOGUE, catalogueEntry } from "../integrations/catalogue.ts";

/** Days a person approves before sending is automatic (decision 4), and the most it may be set to. */
export const DEFAULT_APPROVE_UNTIL = 14;
export const MAX_APPROVE_UNTIL = 365;
/** Days a day waits before it is built, so its late webhooks have arrived. */
export const DEFAULT_SETTLE_DAYS = 2;
export const MAX_SETTLE_DAYS = 14;

/**
 * What a mapping row maps. `category`, `tax` and `method` are one row per host key (a report
 * category, a tax code, a recorded-payment kind); the others are one row each.
 */
export const ACCOUNTING_MAP_KINDS = [
  "category",
  "tax",
  "fees",
  "clearing",
  "bank",
  "method",
  "rounding",
  "refunds",
  "invoice_default",
] as const;
export type AccountingMapKind = (typeof ACCOUNTING_MAP_KINDS)[number];
export const KEYED_MAP_KINDS: readonly AccountingMapKind[] = ["category", "tax", "method"];

/** What each kind maps to in the books: an account, or a tax rate. */
export function mapTarget(kind: AccountingMapKind): "account" | "tax_rate" {
  return kind === "tax" ? "tax_rate" : "account";
}

/** A host key: a category key, a tax code or a recorded-payment kind, as the host writes them. */
export const HOST_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i;

export interface AccountingSettings {
  connectionId: string | null;
  resource: string | null;
  startDate: string | null;
  approvedDays: number;
  approveUntil: number;
  settleDays: number;
  enabled: boolean;
  /** Approval is over: entries go to the books without a person approving each day. */
  automatic: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function loadAccountingSettings(
  db: Kysely<CoreDatabase>,
): Promise<AccountingSettings> {
  const row = await db
    .selectFrom("core_accounting_settings")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  const approvedDays = row?.approved_days ?? 0;
  const approveUntil = row?.approve_until ?? DEFAULT_APPROVE_UNTIL;
  return {
    connectionId: row?.connection_id ?? null,
    resource: row?.resource ?? null,
    startDate: row?.start_date ?? null,
    approvedDays,
    approveUntil,
    settleDays: row?.settle_days ?? DEFAULT_SETTLE_DAYS,
    enabled: row?.enabled === 1,
    automatic: approvedDays >= approveUntil,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** The vendors of the gatekeepers that serve the accounting contract. */
export function accountingVendors(): string[] {
  return CATALOGUE.filter((entry) => entry.implements === "accounting").map((e) => e.vendor);
}

export interface BooksChoice {
  connectionId: string;
  vendor: string;
  title: string;
  status: string;
  /** The books resources bound on the connection: each one's key and its URL. */
  resources: { key: string; url: string | null }[];
}

function boundResources(raw: string): { key: string; url: string | null }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: { key: string; url: string | null }[] = [];
  for (const bound of parsed as { key?: unknown; url?: unknown }[]) {
    if (typeof bound?.key !== "string") continue;
    out.push({ key: bound.key, url: typeof bound.url === "string" ? bound.url : null });
  }
  return out;
}

/** The org connections of an accounting gatekeeper, any status, oldest first (at most 20). */
export async function booksChoices(db: Kysely<CoreDatabase>): Promise<BooksChoice[]> {
  const vendors = accountingVendors();
  if (vendors.length === 0) return [];
  const rows = await db
    .selectFrom("core_integration_connection")
    .select(["id", "vendor", "title", "status", "resources"])
    .where("vendor", "in", vendors)
    .where("scope", "=", "org")
    .orderBy("created_at")
    .limit(20)
    .execute();
  return rows.map((row) => ({
    connectionId: row.id,
    vendor: row.vendor,
    title: row.title,
    status: row.status,
    resources: boundResources(row.resources),
  }));
}

/**
 * The connection and resource a person chose as the books: an org connection of a gatekeeper
 * that implements accounting, with that resource bound on it. Refuses anything else.
 */
export async function requireBooks(
  db: Kysely<CoreDatabase>,
  connectionId: string,
  resource: string,
): Promise<BooksChoice> {
  const row = await db
    .selectFrom("core_integration_connection")
    .select(["id", "vendor", "title", "status", "resources", "scope"])
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (row?.scope !== "org" || catalogueEntry(row.vendor)?.implements !== "accounting") {
    throw new ValidationError(
      "That is not an accounting connection: an admin connects the books in Settings → Integrations",
      { field: "connection", rule: "accounting_not_books" },
    );
  }
  const resources = boundResources(row.resources);
  if (!resources.some((r) => r.key === resource)) {
    throw new ValidationError("Those books are not bound on that connection", {
      field: "connection.resource",
      rule: "accounting_not_books",
    });
  }
  return {
    connectionId: row.id,
    vendor: row.vendor,
    title: row.title,
    status: row.status,
    resources,
  };
}

/** Refuses when nothing is connected as the books yet. */
export function requireConnection(settings: AccountingSettings): string {
  if (!settings.connectionId) {
    throw new ConflictError(
      "No books are chosen yet: a human admin chooses the accounting connection first",
      { rule: "accounting_no_books" },
    );
  }
  return settings.connectionId;
}

export interface MappingRow {
  kind: AccountingMapKind;
  /** The category key, tax code or recorded-payment kind; null for the single kinds. */
  hostKey: string | null;
  booksRef: string;
  booksName: string;
  setBy: string;
  setAt: string;
}

/** The mapping for one connection, by kind and key. At most 1,000 rows. */
export async function loadMapping(
  db: Kysely<CoreDatabase>,
  connectionId: string,
): Promise<MappingRow[]> {
  const rows = await db
    .selectFrom("core_accounting_map")
    .selectAll()
    .where("connection_id", "=", connectionId)
    .orderBy("kind")
    .orderBy("host_key")
    .limit(1000)
    .execute();
  return rows.map((r) => ({
    kind: r.kind,
    hostKey: r.host_key === "" ? null : r.host_key,
    booksRef: r.books_ref,
    booksName: r.books_name,
    setBy: r.set_by,
    setAt: r.set_at,
  }));
}

/** Checks a mapping row's key against its kind: keyed kinds need one, the others take none. */
export function mapKey(kind: AccountingMapKind, hostKey: string | null | undefined): string {
  const key = hostKey?.trim() ?? "";
  if (KEYED_MAP_KINDS.includes(kind)) {
    if (!key || !HOST_KEY_RE.test(key)) {
      throw new ValidationError(`A ${kind} mapping names its ${keyNoun(kind)}`, {
        field: "hostKey",
        rule: "accounting_map_key",
      });
    }
    return key;
  }
  if (key) {
    throw new ValidationError(`There is one ${kind} mapping: it takes no key`, {
      field: "hostKey",
      rule: "accounting_map_key",
    });
  }
  return "";
}

function keyNoun(kind: AccountingMapKind): string {
  if (kind === "category") return "category key";
  if (kind === "tax") return "tax code";
  return "recorded-payment kind";
}
