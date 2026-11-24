// Stage 62 step 1 (ADR 0890): the customer's calendar feed's route, `GET /api/v1/me/feed/<token>.ics`,
// which a calendar app polls with no sign-in, through the shared feed module the staff feed uses
// (whose own tests, staffing-feed.test.ts, pass unchanged on it). Acceptance criterion 4 at the
// HTTP edge:
//
// - the customer's own bookings as RFC 5545, a stable UID `<object>.<id>@<hostname>` each, the
//   public title and place, and no text that could add a property or an event;
// - a made-up, malformed, rotated or revoked token, a disabled account's and a deleted one's all
//   get the same 404 as a route that does not exist; a customer's token on the staff route, and a
//   staff token on this one, too;
// - private, never cached, never indexed, never sniffed, no Referer; limited per token and per
//   client address, by its own bindings; the token never in a log line; not through the binding.
// What the feed shows, and who makes one, are tested in packages/core/test/customer-calendar-feed.test.ts.
// All names are fixture names.
import { env } from "cloudflare:workers";
import {
  applyPlan,
  invokeByName,
  memoryRateLimit,
  newId,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../src/server/http/api.ts";
import { handleBound } from "../src/server/http/bound.ts";
import { type CustomerFeedEnv, handleCustomerFeed } from "../src/server/http/customer-feed.ts";
import { handleStaffFeed } from "../src/server/http/staffing-feed.ts";
import { testEnv, unique } from "./mcp-helpers.ts";

const db = createCrmDb(env.DB);
const ext = `cfeedroute${Date.now().toString(36)}`;
const BOOKING = `${ext}.booking`;
const HOST = "https://host.test";
const NOW = "2026-06-15T00:00:00.000Z";
const at = (days: number, hour = 8) =>
  new Date(Date.parse(NOW) + days * 86_400_000 + hour * 3_600_000).toISOString();
const plus = (iso: string, minutes = 60) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const fixture = manifestSchema.parse({
  id: ext,
  version: "1.0.0",
  contractVersion: 1,
  objects: {
    kind: {
      label: "Class type",
      plural: "Class types",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
      public: { read: ["name"] },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title" },
        kind: { type: "relation", label: "Class type", to: `${ext}.kind` },
        place: { type: "text", label: "Place" },
        startsAt: { type: "datetime", label: "Starts at", required: true },
        endsAt: { type: "datetime", label: "Ends at", required: true },
      },
      public: { read: ["kind", "place", "startsAt", "endsAt"] },
      customerVia: {
        from: `${ext}.booking`,
        field: "klass",
        read: ["title", "kind", "place", "startsAt", "endsAt"],
      },
    },
    booking: {
      label: "Booking",
      plural: "Bookings",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title" },
        klass: { type: "relation", label: "Class", to: `${ext}.klass`, required: true },
        person: { type: "relation", label: "Person", to: "person" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "booked", label: "Booked" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "booked",
        moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
      },
      customer: { field: "person", read: ["person", "klass", "state"], write: [] },
      calendarEntry: {
        starts: "klass.startsAt",
        ends: "klass.endsAt",
        title: "klass.kind.name",
        place: "klass.place",
        live: ["booked"],
      },
    },
  },
});

interface Account {
  id: string;
  personId: string;
  token: string;
}
let sam: Account;
let ann: Account;
let samBooking: string;
let staffToken: string;

const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const newToken = () => {
  let binary = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let adminCtx: Parameters<typeof invokeByName>[2];

async function account(name: string): Promise<Account> {
  const person = (await invokeByName("person.create", { displayName: name }, adminCtx)) as {
    id: string;
  };
  const id = `cus_${unique("cfeed")}`;
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, person.id, `${unique("cfeed")}@buyers.example`, NOW, NOW)
    .run();
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO core_customer_feed (customer_id, token_hash, created_at) VALUES (?, ?, ?)",
  )
    .bind(id, await sha256(token), NOW)
    .run();
  return { id, personId: person.id, token };
}

const feedEnv = (overrides: Partial<CustomerFeedEnv> = {}): CustomerFeedEnv => ({
  DB: env.DB,
  BETTER_AUTH_SECRET: "feed-test-secret",
  CUSTOMER_FEED_RATE_LIMIT: memoryRateLimit(10_000),
  CUSTOMER_FEED_ADDRESS_RATE_LIMIT: memoryRateLimit(10_000),
  ...overrides,
});
const path = (token: string) => `/api/v1/me/feed/${token}.ics`;
const staffPath = (token: string) => `/api/v1/staffing/feed/${token}.ics`;
const get = (
  p: string,
  options: { env?: CustomerFeedEnv; method?: string; headers?: Record<string, string> } = {},
) =>
  handleCustomerFeed(
    new Request(`${HOST}${p}`, {
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
    }),
    options.env ?? feedEnv(),
    () => new Date(NOW),
  );
const getStaff = (p: string) =>
  handleStaffFeed(
    new Request(`${HOST}${p}`),
    {
      DB: env.DB,
      BETTER_AUTH_SECRET: "feed-test-secret",
      STAFF_FEED_RATE_LIMIT: memoryRateLimit(10_000),
      STAFF_FEED_ADDRESS_RATE_LIMIT: memoryRateLimit(10_000),
    },
    () => new Date(NOW),
  );

/** A strict reading as RFC 5545 content lines; answers the unfolded lines. */
function parse(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  for (const line of ics.split("\r\n")) {
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  }
  const lines = ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
  const stack: string[] = [];
  for (const line of lines) {
    expect(line).toMatch(/^[A-Z][A-Z0-9-]*(;[A-Z0-9-]+=[^;:]+)*:/);
    if (line.startsWith("BEGIN:")) stack.push(line.slice(6));
    if (line.startsWith("END:")) expect(stack.pop()).toBe(line.slice(4));
  }
  expect(stack).toEqual([]);
  return lines;
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

beforeAll(async () => {
  const plan = await planReconcile(db.query, fixture, { now: NOW });
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  const adminId = newId("user");
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(adminId, "Admin Fixture", `${unique("cfeed")}@example.com`, NOW, NOW)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(adminId).run();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify({ id: ext, version: "1.0.0", tools: {} }), adminId, NOW, NOW)
    .run();
  adminCtx = {
    actor: "human" as const,
    user: { id: adminId, email: "a@example.com", name: "Admin Fixture", role: "admin" as const },
    origin: { surface: "ui" as const },
    db,
    clock: () => new Date(NOW),
  };
  const create = async (object: string, values: Record<string, unknown>) =>
    ((await invokeByName("record.create", { object, values }, adminCtx)) as { id: string }).id;
  sam = await account("Sam Fixture");
  ann = await account("Ann Fixture");
  const kind = await create(`${ext}.kind`, { name: "Strength, back; room\\" });
  const klass = await create(`${ext}.klass`, {
    title: "Strength with Zed Member",
    kind,
    startsAt: at(2, 9),
    endsAt: plus(at(2, 9), 45),
    // Text that would end its line and start a property or an event, were it not neutralised.
    place: "Main floor\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nX-EVIL:1",
  });
  samBooking = await create(BOOKING, { klass, person: sam.personId });
  const annKlass = await create(`${ext}.klass`, {
    kind,
    startsAt: at(3, 9),
    endsAt: plus(at(3, 9)),
    place: "Studio A",
  });
  await create(BOOKING, { klass: annKlass, person: ann.personId });
  // A staff feed's token, stored in the staff table.
  staffToken = newToken();
  await env.DB.prepare(
    "INSERT INTO core_staff_feed (account_id, token_hash, tool, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(adminId, await sha256(staffToken), `x.${ext}.feedRotate`, NOW)
    .run();
});

afterEach(() => vi.restoreAllMocks());

describe("the feed (criterion 1)", () => {
  it("is the customer's own bookings as RFC 5545, private and never cached", async () => {
    const response = await get(path(sam.token));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="bookings.ics"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const ics = await response.text();
    const lines = parse(ics);
    expect(lines.slice(0, 5)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Composable OS//Customer calendar feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ]);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain(`UID:${BOOKING}.${samBooking}@host.test`);
    expect(lines).toContain("DTSTART:20260617T090000Z");
    expect(lines).toContain("DTEND:20260617T094500Z");
    expect(lines).toContain("DTSTAMP:20260617T090000Z");
    expect(lines).toContain("SEQUENCE:0");
    expect(lines).toContain("SUMMARY:Strength\\, back\\; room\\\\");
    expect(lines).toContain("LOCATION:Main floor\\nEND:VEVENT\\nBEGIN:VEVENT\\nX-EVIL:1");
    expect(lines.filter((l) => l.startsWith("X-EVIL"))).toEqual([]);
    for (const absent of ["Ann", "Zed", "Studio A", ann.personId, "Sam"]) {
      expect(ics).not.toContain(absent);
    }
    // The same bytes on the next poll.
    expect(await (await get(path(sam.token))).text()).toBe(ics);
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await get(path(sam.token), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("a token that opens nothing (criterion 4)", () => {
  it("made-up, malformed, rotated, revoked, disabled and deleted, and the other feed's: one 404", async () => {
    const rotated = await account("Rae Fixture");
    await env.DB.prepare("UPDATE core_customer_feed SET token_hash = ? WHERE customer_id = ?")
      .bind(await sha256(newToken()), rotated.id)
      .run();
    const revoked = await account("Rev Fixture");
    await env.DB.prepare("DELETE FROM core_customer_feed WHERE customer_id = ?")
      .bind(revoked.id)
      .run();
    const disabled = await account("Dis Fixture");
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE id = ?")
      .bind(disabled.id)
      .run();
    const deleted = await account("Del Fixture");
    await env.DB.prepare("DELETE FROM core_customer WHERE id = ?").bind(deleted.id).run();
    const answers = await Promise.all(
      [
        path(newToken()),
        path(rotated.token),
        path(revoked.token),
        path(disabled.token),
        path(deleted.token),
        // A staff feed's token is never looked up on the customer's route.
        path(staffToken),
        path("short"),
        path(`${sam.token}x`),
        `/api/v1/me/feed/${sam.token}`,
        `/api/v1/me/feed/${sam.token}.ICS`,
        `/api/v1/me/feed/${sam.token}.ics/x`,
        "/api/v1/me/feed/",
        "/api/v1/me/feed",
      ].map(async (p) => snapshot(await get(p))),
    );
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0]?.status).toBe(404);
    expect(JSON.parse(answers[0]?.body ?? "")).toEqual({
      error: { code: "not_found", message: "No such route" },
    });
    // A deleted account's row went with it (the cascade).
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_feed WHERE customer_id = ?",
    )
      .bind(deleted.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("a customer's token on the staff route is the staff route's own 404", async () => {
    const staffMissing = await snapshot(await getStaff(staffPath(newToken())));
    const customerThere = await snapshot(await getStaff(staffPath(sam.token)));
    expect(staffMissing.status).toBe(404);
    expect(customerThere).toEqual(staffMissing);
  });

  it("refuses any method but GET and HEAD", async () => {
    const response = await get(path(sam.token), { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("is not served through the client-app binding", async () => {
    const response = await handleBound(
      new Request(`https://host.internal${path(sam.token)}`),
      testEnv() as unknown as ApiEnv,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
  });
});

describe("limits, its own (criterion 4)", () => {
  it("per token: over the limit, 429 with Retry-After", async () => {
    const limited = feedEnv({ CUSTOMER_FEED_RATE_LIMIT: memoryRateLimit(2) });
    expect((await get(path(sam.token), { env: limited })).status).toBe(200);
    expect((await get(path(sam.token), { env: limited })).status).toBe(200);
    const over = await get(path(sam.token), { env: limited });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(over.headers.get("cache-control")).toBe("private, no-store");
    expect((await get(path(ann.token), { env: limited })).status).toBe(200);
  });

  it("per client address, before any token is looked up", async () => {
    const limited = feedEnv({ CUSTOMER_FEED_ADDRESS_RATE_LIMIT: memoryRateLimit(2) });
    const from = { "cf-connecting-ip": "203.0.113.7" };
    expect((await get(path(newToken()), { env: limited, headers: from })).status).toBe(404);
    expect((await get(path(newToken()), { env: limited, headers: from })).status).toBe(404);
    expect((await get(path(sam.token), { env: limited, headers: from })).status).toBe(429);
    const other = { "cf-connecting-ip": "198.51.100.9" };
    expect((await get(path(sam.token), { env: limited, headers: other })).status).toBe(200);
  });
});

describe("the token is never logged", () => {
  it("in no log line, whether it opens a feed, opens nothing, or the database fails", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
        );
      });
    }
    await get(path(sam.token));
    await get(path(newToken()));
    const broken = feedEnv({
      DB: {
        prepare: () => {
          throw new Error(`D1 failed for ${sam.token}`);
        },
      } as unknown as D1Database,
    });
    const failed = await get(path(sam.token), { env: broken });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(sam.token);
    expect(lines.join("\n")).not.toContain(sam.token);
    expect(lines.some((l) => l.includes("customer calendar feed could not be served"))).toBe(true);
  });
});
