// `cos subscriptions offers import` (stage 32a, ADRs 0491 and 0492): the file it reads and the
// problems it names with their line before anyone signs in, the dry run before the write, and the
// report. Against a real host: apps/app/test/offers-import.test.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportHost } from "../src/import-door/host.ts";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";
import {
  offersReportLines,
  readOffersFile,
  resolvePlan,
  runOffersImport,
} from "../src/offers-import/engine.ts";

describe("the offers file", () => {
  it("reads email, paid-up date and reference by header, each row with its line", () => {
    const file = readOffersFile(
      '﻿Email,Paid up to,Reference\r\nA@Example.com,2026-12-15,sub_1\r\n\r\n"b@example.com",2026-12-20T09:00:00+10:00,\n',
    );
    expect(file.problems).toEqual([]);
    expect(file.rows).toEqual([
      { line: 2, email: "a@example.com", freeUntil: "2026-12-15", reference: "sub_1" },
      { line: 4, email: "b@example.com", freeUntil: "2026-12-20T09:00:00+10:00" },
    ]);
  });

  it("names every problem with its file and line", () => {
    const file = readOffersFile(
      [
        "email,free_until",
        "not-an-address,2026-12-15",
        "c@example.com,15/12/2026",
        "d@example.com,2026-12-15",
        "D@example.com,2026-12-16",
      ].join("\n"),
      "moving.csv",
    );
    expect(file.problems).toEqual([
      { file: "moving.csv:2", message: 'not an email address: "not-an-address"' },
      {
        file: "moving.csv:3",
        message:
          'the paid-up date is not a real date (YYYY-MM-DD) or moment with its offset: "15/12/2026"',
      },
      { file: "moving.csv:5", message: "d@example.com is on line 4 already" },
    ]);
    expect(readOffersFile("name,date\nx,y").problems[0]?.message).toMatch(/must name email/);
    // An impossible day or time is never rolled forward into extra free days.
    const impossible = readOffersFile(
      [
        "email,paid_up_to",
        "a@example.com,2026-02-30T00:00Z",
        "b@example.com,2026-12-15T24:00Z",
        "c@example.com,2026-12-15T10:00+15:00",
        "d@example.com,2026-02-29",
        "e@example.com,2028-02-29T12:30:00.5+10:00",
      ].join("\n"),
    );
    expect(impossible.problems.map((p) => p.file)).toEqual([
      "offers.csv:2",
      "offers.csv:3",
      "offers.csv:4",
      "offers.csv:5",
    ]);
    expect(impossible.rows.map((r) => r.line)).toEqual([6]);
    expect(readOffersFile("").problems[0]?.message).toBe("the file is empty");
  });
});

/** A host that answers the offer import as the real one does, and records what it was sent. */
function fakeHost(answer: (row: { email: string }) => Record<string, unknown>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host: ImportHost = {
    async call<T>(name: string, input: unknown): Promise<T> {
      calls.push({ name, input: input as Record<string, unknown> });
      if (name === "record.get") {
        return { id: (input as { id: string }).id, title: "Every course", values: {} } as T;
      }
      if (name === "record.list") {
        return {
          items: [{ id: "rec_plan", title: "Every course", values: {} }],
          nextCursor: null,
        } as T;
      }
      const rows = (input as { rows: { email: string }[] }).rows;
      return {
        results: rows.map((r) => ({
          email: r.email,
          offerId: "sof_1",
          personId: "per_1",
          freeUntil: "2026-12-15T00:00:00.000Z",
          note: null,
          signIn: null,
          outcome: "created",
          ...answer(r),
        })),
      } as T;
    },
    async upload() {
      throw new Error("no uploads");
    },
  };
  return { host, calls };
}

describe("the import", () => {
  it("checks every row in a dry run first, then writes; reports unmatched rows with their line", async () => {
    const file = readOffersFile(
      "email,paid_up_to\na@example.com,2026-12-15\nnobody@example.com,2026-12-15\nsoon@example.com,2026-11-23\n",
    );
    const { host, calls } = fakeHost((r) =>
      r.email.startsWith("nobody")
        ? {
            outcome: "unmatched",
            offerId: null,
            personId: null,
            note: "no person has this address",
          }
        : r.email.startsWith("soon")
          ? { note: "under_48_hours", signIn: "has_account" }
          : {},
    );
    const plan = await resolvePlan(host, "courses.plan");
    expect(plan).toEqual({ object: "courses.plan", id: "rec_plan", title: "Every course" });
    const report = await runOffersImport(file, host, { plan, dryRun: false, invite: false });
    const sent = calls.filter((c) => c.name === "subscription.offer.import");
    expect(sent.map((c) => c.input.dryRun)).toEqual([true, false]);
    expect(sent[0]?.input.plan).toEqual({ object: "courses.plan", id: "rec_plan" });
    expect(report.problems.map((p) => [p.line, p.outcome])).toEqual([[3, "unmatched"]]);
    const lines = offersReportLines(report, "offers.csv");
    expect(lines[0]).toContain("2 were created, 0 updated, 0 unchanged; 1 not written");
    expect(lines).toContain(
      "  offers.csv:3 nobody@example.com: unmatched: no person has this address: import the people first",
    );
    expect(lines.some((l) => l.startsWith("  offers.csv:4 soon@example.com: under 48 hours"))).toBe(
      true,
    );
    // The one with no account and no invite: what the company must set, said once.
    expect(lines.some((l) => l.includes("only while customer sign-up is open"))).toBe(true);
  });

  it("writes nothing on --dry-run", async () => {
    const file = readOffersFile("email,paid_up_to\na@example.com,2026-12-15\n");
    const { host, calls } = fakeHost(() => ({}));
    const plan = await resolvePlan(host, "courses.plan:rec_plan");
    const report = await runOffersImport(file, host, { plan, dryRun: true, invite: true });
    expect(
      calls.filter((c) => c.name === "subscription.offer.import").map((c) => c.input.dryRun),
    ).toEqual([true]);
    expect(offersReportLines(report)[0]).toContain("1 would be created");
  });

  it("stops on a bad file before signing in, and asks for --host and --plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-offers-"));
    const bad = join(dir, "offers.csv");
    writeFileSync(bad, "email,paid_up_to\nnope,2026-12-15\n");
    const out: string[] = [];
    let fetched = 0;
    const deps: Parameters<typeof runCli>[1] = {
      io: {
        interactive: false,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        ask: async () => {
          throw new Error("no prompts in tests");
        },
      },
      redactor: new Redactor(),
      env: {},
      ghVerifier: null,
      fetch: (async () => {
        fetched += 1;
        throw new Error("no network in this test");
      }) as never,
    };
    expect(await runCli(["subscriptions", "offers", "import", bad], deps)).toBe(2);
    expect(out.join("\n")).toContain("--host");
    out.length = 0;
    expect(
      await runCli(
        ["subscriptions", "offers", "import", bad, "--host", "https://admin.example.com"],
        deps,
      ),
    ).toBe(2);
    expect(out.join("\n")).toContain("--plan");
    out.length = 0;
    expect(
      await runCli(
        [
          "subscriptions",
          "offers",
          "import",
          bad,
          "--host",
          "https://admin.example.com",
          "--plan",
          "courses.plan",
        ],
        deps,
      ),
    ).toBe(1);
    expect(out.join("\n")).toContain("offers.csv:2: not an email address");
    expect(fetched).toBe(0);
    expect(await runCli(["subscriptions", "nothing"], deps)).toBe(2);
  });
});

describe("the import's races and its plan", () => {
  it("sends a batch again when an offer changed while it was written, and names a plan by its id", async () => {
    const file = readOffersFile("email,paid_up_to\na@example.com,2026-12-15\n");
    const calls: string[] = [];
    let refused = 1;
    const host: ImportHost = {
      async call<T>(name: string, input: unknown): Promise<T> {
        calls.push(name);
        if (name === "record.get") {
          return { id: (input as { id: string }).id, title: "Plan by id", values: {} } as T;
        }
        if (!(input as { dryRun: boolean }).dryRun && refused-- > 0) {
          throw Object.assign(new Error("changed"), {
            code: "conflict",
            details: { rule: "offer_changed" },
          });
        }
        return {
          results: [
            {
              email: "a@example.com",
              outcome: "conflict",
              offerId: "sof_1",
              personId: "per_1",
              freeUntil: null,
              note: "taken",
              signIn: null,
            },
          ],
        } as T;
      },
      async upload() {
        throw new Error("no uploads");
      },
    };
    const plan = await resolvePlan(host, "courses.plan:rec_far_down_the_list");
    expect(plan).toEqual({
      object: "courses.plan",
      id: "rec_far_down_the_list",
      title: "Plan by id",
    });
    expect(calls).toEqual(["record.get"]);
    const report = await runOffersImport(file, host, { plan, dryRun: false, invite: false });
    // The dry run, the refused write, and the write again, which answers what is true now.
    expect(calls.slice(1)).toEqual([
      "subscription.offer.import",
      "subscription.offer.import",
      "subscription.offer.import",
    ]);
    expect(report.problems.map((p) => [p.line, p.note])).toEqual([[2, "taken"]]);
  });
});
