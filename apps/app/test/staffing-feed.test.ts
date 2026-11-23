// Stage 45 step 5 (ADR 0628): the calendar feed's route, `GET /api/v1/staffing/feed/<token>.ics`,
// which a calendar app polls with no sign-in. Acceptance criterion 9 at the HTTP edge:
//
// - the person's own shifts as RFC 5545 (CRLF, folded, escaped, UTC, a stable UID per shift),
//   with nothing of anyone else and no text that could add a property or an event;
// - a made-up, malformed, rotated or revoked token, and a deactivated person's, all get the same
//   404 as a route that does not exist; any other method, 405;
// - private, never cached, never indexed, never sniffed, no Referer;
// - limited per token and per client address;
// - the token never in a log line, even when the database fails;
// - not served through the client-app binding.
// What the feed shows, and who may have one, are tested in packages/core/test/staffing-feed.test.ts.
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
import { handleStaffFeed, type StaffFeedEnv } from "../src/server/http/staffing-feed.ts";
import { testEnv, unique } from "./mcp-helpers.ts";

const db = createCrmDb(env.DB);
const ext = `feedroute${Date.now().toString(36)}`;
const DUTY = `${ext}.duty`;
const KIND = `${ext}.kind`;
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
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    duty: {
      label: "Duty shift",
      plural: "Duty shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Duty", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        place: { type: "text", label: "Place" },
        notes: { type: "longText", label: "Notes" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
        place: "place",
      },
      indexes: [["startsAt"]],
    },
  },
});

const installed = {
  id: ext,
  version: "1.0.0",
  tools: {
    feedRotate: {
      description: "A new feed address for yourself, shown once.",
      risk: "write",
      humanOnly: true,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
    },
  },
};

interface Person {
  id: string;
  name: string;
  token: string;
}
let sam: Person;
let ann: Person;
let samDuty: string;

const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const newToken = () => {
  let binary = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function person(name: string, role: "admin" | "member" = "member"): Promise<Person> {
  const id = newId("user");
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, name, `${unique("feed")}@example.com`, NOW, NOW)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, id).run();
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO core_staff_feed (account_id, token_hash, tool, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, await sha256(token), `x.${ext}.feedRotate`, NOW)
    .run();
  return { id, name, token };
}

const feedEnv = (overrides: Partial<StaffFeedEnv> = {}): StaffFeedEnv => ({
  DB: env.DB,
  BETTER_AUTH_SECRET: "feed-test-secret",
  STAFF_FEED_RATE_LIMIT: memoryRateLimit(10_000),
  STAFF_FEED_ADDRESS_RATE_LIMIT: memoryRateLimit(10_000),
  ...overrides,
});
const path = (token: string) => `/api/v1/staffing/feed/${token}.ics`;
const get = (
  p: string,
  options: { env?: StaffFeedEnv; method?: string; headers?: Record<string, string> } = {},
) =>
  handleStaffFeed(
    new Request(`${HOST}${p}`, {
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
    }),
    options.env ?? feedEnv(),
    () => new Date(NOW),
  );

/** A strict reading as RFC 5545 content lines; answers the unfolded lines. */
function parse(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  for (const line of ics.split("\r\n")) {
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  }
  const lines = ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
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
  const admin = await person("Admin Fixture", "admin");
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  sam = await person("Sam Fixture");
  ann = await person("Ann Fixture");
  const ctx = {
    actor: "human" as const,
    user: { id: admin.id, email: "a@example.com", name: admin.name, role: "admin" as const },
    origin: { surface: "ui" as const },
    db,
    clock: () => new Date(NOW),
  };
  const create = async (object: string, values: Record<string, unknown>) =>
    ((await invokeByName("record.create", { object, values }, ctx)) as { id: string }).id;
  const clean = await create(KIND, { name: "Close-down clean, back; room\\" });
  samDuty = await create(DUTY, {
    name: "Clean after Zed Member's session",
    kind: clean,
    staff: sam.id,
    startsAt: at(2, 9),
    endsAt: plus(at(2, 9), 45),
    // Text that would end its line and start a property or an event, were it not neutralised.
    place: "Main floor\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nX-EVIL:1",
    notes: "Zed Member's notes",
  });
  await create(DUTY, {
    kind: clean,
    staff: ann.id,
    startsAt: at(2, 9),
    endsAt: plus(at(2, 9), 45),
    place: "Studio A",
  });
});

afterEach(() => vi.restoreAllMocks());

describe("the feed (criterion 9)", () => {
  it("is the person's own shifts as RFC 5545, private and never cached", async () => {
    const response = await get(path(sam.token));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
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
      "PRODID:-//Composable OS//Staff calendar feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ]);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain(`UID:${samDuty}@host.test`);
    expect(lines).toContain("DTSTART:20260617T090000Z");
    expect(lines).toContain("DTEND:20260617T094500Z");
    expect(lines).toContain("SUMMARY:Close-down clean\\, back\\; room\\\\");
    expect(lines).toContain(
      "LOCATION:Main floor\\nEND:VEVENT\\nBEGIN:VEVENT\\nX-EVIL:1",
    );
    expect(lines.filter((l) => l.startsWith("X-EVIL"))).toEqual([]);
    // Nothing of anyone else, nothing a business typed about a member.
    for (const absent of ["Ann", "Zed", "Studio A", ann.id, "notes"]) {
      expect(ics).not.toContain(absent);
    }
    // The same bytes on the next poll.
    expect(await (await get(path(sam.token))).text()).toBe(ics);
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await get(path(sam.token), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  });
});

describe("a token that opens nothing (criterion 9)", () => {
  it("made-up, malformed, rotated, revoked and a deactivated person's: one identical 404", async () => {
    const rotatedFrom = (await person("Rae Fixture")).token;
    await env.DB.prepare("UPDATE core_staff_feed SET token_hash = ? WHERE token_hash = ?")
      .bind(await sha256(newToken()), await sha256(rotatedFrom))
      .run();
    const revoked = await person("Rev Fixture");
    await env.DB.prepare("DELETE FROM core_staff_feed WHERE account_id = ?").bind(revoked.id).run();
    const left = await person("Lee Fixture");
    await invokeByName(
      "user.deactivate",
      { id: left.id, confirm: 0 },
      {
        actor: "human",
        user: { id: (await person("Ad2 Fixture", "admin")).id, email: "b@example.com", name: "Ad2", role: "admin" },
        origin: { surface: "ui" },
        db,
      },
    );
    const answers = await Promise.all(
      [
        path(newToken()),
        path(rotatedFrom),
        path(revoked.token),
        path(left.token),
        path("short"),
        path(`${sam.token}x`),
        `/api/v1/staffing/feed/${sam.token}`,
        `/api/v1/staffing/feed/${sam.token}.ICS`,
        `/api/v1/staffing/feed/${sam.token}.ics/x`,
        "/api/v1/staffing/feed/",
        "/api/v1/staffing/feed",
      ].map(async (p) => snapshot(await get(p))),
    );
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0]?.status).toBe(404);
    // The same body as the surface's own answer to a route that does not exist.
    expect(JSON.parse(answers[0]?.body ?? "")).toEqual({
      error: { code: "not_found", message: "No such route" },
    });
    expect(answers[0]?.headers).toContainEqual(["cache-control", "private, no-store"]);
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

describe("limits", () => {
  it("per token: over the limit, 429 with Retry-After, a made-up token alike", async () => {
    const limited = feedEnv({ STAFF_FEED_RATE_LIMIT: memoryRateLimit(2) });
    expect((await get(path(sam.token), { env: limited })).status).toBe(200);
    expect((await get(path(sam.token), { env: limited })).status).toBe(200);
    const over = await get(path(sam.token), { env: limited });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    // Another token is counted on its own.
    expect((await get(path(ann.token), { env: limited })).status).toBe(200);
  });

  it("per client address, before any token is looked up", async () => {
    const byAddress = memoryRateLimit(2);
    const limited = feedEnv({ STAFF_FEED_ADDRESS_RATE_LIMIT: byAddress });
    const from = { "cf-connecting-ip": "203.0.113.7" };
    expect((await get(path(newToken()), { env: limited, headers: from })).status).toBe(404);
    expect((await get(path(newToken()), { env: limited, headers: from })).status).toBe(404);
    // A guesser's next try, even with a real token, is refused.
    expect((await get(path(sam.token), { env: limited, headers: from })).status).toBe(429);
    // Another address is counted on its own.
    const other = { "cf-connecting-ip": "198.51.100.9" };
    expect((await get(path(sam.token), { env: limited, headers: other })).status).toBe(200);
  });
});

describe("the token is never logged", () => {
  it("in no log line, whether it opens a feed, opens nothing, or the database fails", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
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
    expect(lines.some((l) => l.includes("staff calendar feed could not be served"))).toBe(true);
  });
});
