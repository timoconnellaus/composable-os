// Stage 61 step 4: what the outbox runner's tests share. The fake books (packages/gatekeeper-
// accounting) are connected for the org and bound, the sync is on with a start date, and the
// runner reaches them through the real integration host as the host (`callAsHost`, purpose
// `accounting`). Entries are queued as steps 5 and 6 will queue them (`queuePost`), with the
// mapping's keys where the books' refs go.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type Actor,
  invokeByName,
  type QueuePostInput,
  queuePost,
  type RunnerDeps,
  runAccounting,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, unique } from "./helpers.ts";

export const integrations = integrationRuntime(env);

/** The fake books' controls, as a bookkeeper (or a failing network) would use them. */
export interface FakeRecord {
  ref: string;
  kind: string;
  reference: string | null;
  date: string;
  voided: boolean;
  document?: string;
  input: Record<string, unknown> & { text?: string; date?: string; lines?: { text: string }[] };
}
export const books = env.TEST_ACCOUNTING_BOOKS as unknown as {
  reset(
    books: string,
    overrides?: { baseCurrency?: string; lockDate?: string | null },
  ): Promise<void>;
  failNext(
    books: string,
    method: string,
    failure: { refuse: string } | "unknown" | "unknown_after_write",
  ): Promise<void>;
  writesOf(books: string, reference: string): Promise<number>;
  setLockDate(books: string, date: string | null): Promise<void>;
  setUnavailable(books: string, on: boolean): Promise<void>;
  state(books: string): Promise<{ records: FakeRecord[]; writes: Record<string, number> }>;
};

export const ZONE = "Australia/Sydney";
export const START = "2026-11-01";

export interface Books {
  admin: ActingUser;
  name: string;
  connectionId: string;
  resource: string;
}

export type Caller = { actor: Actor; user: ActingUser };

/** Calls an operation as `actor` (a person at the screen by default). */
export function op<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  actor: Actor = "human",
  db: CrmDb = createCrmDb(env.DB),
): Promise<T> {
  const origin =
    actor === "extension"
      ? { surface: "extension" as const, extensionId: "x" }
      : actor === "assistant"
        ? { surface: "assistant" as const, sessionId: "ath_accounting" }
        : actor === "mcp"
          ? { surface: "mcp" as const, clientId: "c", clientName: "T", sessionId: "cap_accounting" }
          : actor === "automation"
            ? { surface: "automation" as const, automationId: "x.accounting" }
            : { surface: "ui" as const };
  return invokeByName(name, input, { actor, user, origin, db, integrations }) as Promise<T>;
}

async function setting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

/** The accounts and tax rate the fake books keep, mapped as a person would from their lists. */
const MAPPING = [
  { kind: "clearing", booksRef: "acc-clearing", booksName: "Card clearing" },
  { kind: "bank", booksRef: "acc-bank", booksName: "Business account" },
  { kind: "fees", booksRef: "acc-fees", booksName: "Card fees" },
  {
    kind: "category",
    hostKey: "memberships",
    booksRef: "acc-memberships",
    booksName: "Memberships",
  },
  { kind: "tax", hostKey: "gst", booksRef: "tax-gst", booksName: "GST on income" },
] as const;

/**
 * The fake books, connected and bound, chosen as the books by a human admin, mapped, with a
 * start date, and on. Approval is over (`approved` days) unless a test puts it back on.
 */
export async function connectBooks(
  options: { approved?: boolean; map?: boolean } = {},
): Promise<Books> {
  const admin = await createAdmin();
  await setting("org_timezone", ZONE);
  await setting("order_currency", "AUD");
  const name = unique("outbox")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40);
  await books.reset(name);
  await op("integration.setVendor", { vendor: "accounting-fake", enabled: true }, admin);
  const created = await op<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "accounting-fake", scope: "org" },
    admin,
  );
  const bound = await op<{ resource: { key: string } }>(
    "connection.bindResource",
    { id: created.connection.id, url: `accounting-fake://books/${name}` },
    admin,
  );
  await op(
    "accounting.settings.update",
    {
      books: { connectionId: created.connection.id, resource: bound.resource.key },
      startDate: START,
      enabled: true,
    },
    admin,
  );
  if (options.map !== false) {
    for (const row of MAPPING) await op("accounting.map.set", row, admin);
  }
  if (options.approved !== false) {
    await env.DB.prepare("UPDATE core_accounting_settings SET approved_days = approve_until").run();
  }
  return { admin, name, connectionId: created.connection.id, resource: bound.resource.key };
}

/**
 * Leaves the outbox and the books as a fresh test wants them: the fake books empty and up, and
 * every entry earlier tests left unsent skipped (an entry is never deleted), so none holds the
 * next test's up.
 */
export async function clearOutbox(b: Books): Promise<void> {
  await books.reset(b.name);
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE core_accounting_post SET state = 'unknown' WHERE state = 'sending'"),
    env.DB.prepare("UPDATE core_accounting_post SET state = 'queued' WHERE state = 'unknown'"),
    env.DB.prepare(
      "UPDATE core_accounting_post SET state = 'skipped', skipped_by = 'test', skipped_at = ?, skip_reason = 'cleared between tests' WHERE state NOT IN ('sent', 'skipped')",
    ).bind(at),
    env.DB.prepare(
      // The daily pass is its own test's: elsewhere it has nothing to build.
      "UPDATE core_accounting_settings SET approved_days = approve_until, blocked = NULL, daily_date = '2099-12-31', automatic_told_at = coalesce(automatic_told_at, ?)",
    ).bind(at),
  ]);
}

let counter = 0;
/** A source id, unique in the test run. */
export const source = (prefix = "s") => `${prefix}${Date.now().toString(36)}${++counter}`;

/** A balanced summary for `day`: memberships and their tax against the clearing account. */
export function summaryEntry(
  b: Books,
  day: string,
  {
    net = 1000,
    sourceId = source("day"),
    dependsOn,
  }: {
    net?: number;
    sourceId?: string;
    dependsOn?: string;
  } = {},
): QueuePostInput {
  const tax = net / 10;
  return {
    connectionId: b.connectionId,
    kind: "summary",
    sourceKind: "day",
    sourceId,
    belongsDate: day,
    amount: net + tax,
    lines: [
      { account: { map: "clearing" }, taxRate: null, net: net + tax, tax: 0, text: "Card sales" },
      {
        account: { map: "category", key: "memberships" },
        taxRate: { map: "tax", key: "gst" },
        net: -net,
        tax: -tax,
        text: "Memberships",
      },
    ],
    body: { text: `Card sales for ${day}` },
    ...(dependsOn ? { dependsOn } : {}),
  };
}

export async function queue(input: QueuePostInput, now = new Date().toISOString()) {
  const queued = await queuePost(createCrmDb(env.DB).query, input, now);
  if (!queued) throw new Error("not queued");
  return queued;
}

/** One run of the runner at `at`, through the real integration host. */
export function runAt(at: string | Date, extra: Partial<RunnerDeps> = {}) {
  const when = typeof at === "string" ? new Date(at) : at;
  return runAccounting({
    db: createCrmDb(env.DB).query,
    integrations,
    clock: () => when,
    ...extra,
  });
}

export interface PostRow {
  id: string;
  state: string;
  reference: string;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  error_text: string | null;
  books_ref: string | null;
  carries_date: string;
  belongs_date: string;
  request: string | null;
}

export async function post(id: string): Promise<PostRow> {
  const row = await env.DB.prepare("SELECT * FROM core_accounting_post WHERE id = ?")
    .bind(id)
    .first<PostRow>();
  if (!row) throw new Error(`no post ${id}`);
  return row;
}

export const minutes = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 60_000).toISOString();

/** What a call that must be refused was refused with. */
export async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error("expected a refusal");
}
