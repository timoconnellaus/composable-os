// `cos ext check` and `cos ext test` (ADR 0405, stage 21). The broken fixtures in ./fixtures and
// the issues in fixtures/expected.json are shared with apps/runner/test/same-issues.test.ts, which
// puts the same source through the host's `extension.check`: both must report exactly those
// issues. The shipped extensions must pass unchanged.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkExtensionDir, locate } from "../src/node/check.ts";
import { type ExtIo, outsideSummary, rolesSummary, runExt } from "../src/node/cli.ts";
import { readExtensionFiles } from "../src/node/evaluate.ts";
import { untested } from "../src/node/test.ts";
import expected from "./fixtures/expected.json" with { type: "json" };

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
const shipped = (name: string) => join(import.meta.dirname, "..", "..", "..", "packs", name);

function io(): ExtIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

describe("cos ext check on the broken fixtures", () => {
  for (const [name, issues] of Object.entries(expected)) {
    it(`${name}: reports the issues the host reports`, async () => {
      const result = await checkExtensionDir(fixture(name));
      expect(result.ok).toBe(false);
      expect(result.issues.map(({ file: _file, line: _line, ...issue }) => issue)).toEqual(issues);
      for (const issue of result.issues) expect(issue.file).toBe("index.ts");
    });
  }

  it("prints a file, the manifest path and the message, and exits 1", async () => {
    const out = io();
    expect(await runExt(["check", fixture("badformula")], out)).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toMatch(
      /badformula\/index\.ts:\d+ {2}objects\.invoice\.fields\.withTax\.expression/,
    );
    expect(text).toContain('Unknown field "amout"');
    expect(text).toContain("1 issue in");
  });

  it("prints the issues as JSON with --json", async () => {
    const out = io();
    expect(await runExt(["check", fixture("stagerule"), "--json"], out)).toBe(1);
    const parsed = JSON.parse(out.lines.join("\n")) as { ok: boolean; issues: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toHaveLength(expected.stagerule.length);
  });
});

describe("what cos ext check reads of a pack", () => {
  it("the extension's files, as the release bundles them: not client/, blocks/ or tests", () => {
    const files = Object.keys(readExtensionFiles(shipped("programs")));
    expect(files).toContain("index.ts");
    expect(files).toContain("authoring.ts");
    expect(
      files.some(
        (f) => f.startsWith("client/") || f.startsWith("blocks/") || f.startsWith("test/"),
      ),
    ).toBe(false);
  });
});

describe("cos ext check on a pack's sections of My account (stage 48, ADR 0710)", () => {
  it("reads each section's block.json: its pack, its skin, what it calls and its export", async () => {
    const result = await checkExtensionDir(fixture("portalblocks"));
    expect(result.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      'portal.good.native.block: "portalblocks-native-skin" is a web block, named for the native section',
      'portal.staff.web.block: "portalblocks-desk" calls x.portalblocks.day, which no customer may call: a section of My account calls only customer or public operations',
      'portal.foreign.web.block: "portalblocks-other" is not this pack\'s block: its block.json names pack "deals"',
      'portal.gone.web.block: "portalblocks-gone" is not a block of this pack: no blocks/portalblocks-gone/block.json',
      'portal.noExport.web.export: "portalblocks-mine" exports no component Nowhere',
    ]);
  });

  for (const name of ["bookings", "memberships", "courses", "ticketing", "programs"]) {
    it(`${name}'s section names its own blocks, which call only what a customer may`, async () => {
      const result = await checkExtensionDir(shipped(name));
      expect(result.issues.filter((i) => i.path.startsWith("portal"))).toEqual([]);
      expect(Object.keys(result.manifest?.portal ?? {})).toHaveLength(1);
    });
  }
});

describe("cos ext check on the shipped extensions", () => {
  for (const name of ["deals", "leads", "lifecycle"]) {
    it(`${name} passes unchanged`, async () => {
      const out = io();
      expect(await runExt(["check", shipped(name)], out)).toBe(0);
      expect(out.lines.join("\n")).toMatch(new RegExp(`^ok: ${name} `));
    });

    it(`${name}: every tool and automation is named in a test`, async () => {
      expect(await untested(shipped(name))).toEqual([]);
    });
  }

  it("installs the extension an automation runs only with first, and checks against it (ADR 0812)", async () => {
    const result = await checkExtensionDir(fixture("onlywith/owuser"));
    expect(result.issues.map((i) => i.path)).toEqual(["automations.afterVisit.trigger.object"]);
    expect(result.issues[0]?.message).toContain('Unknown object "owbase.visits"');
  });

  it("reconciles the extension another one builds on first (Leads relates to deals.deal)", async () => {
    const result = await checkExtensionDir(shipped("leads"));
    expect(result.issues).toEqual([]);
    expect(JSON.stringify(result.manifest)).toContain('"deals.deal"');
  });

  it("leaves out one that requires the checked extension: it is installed after it (ADR 0764)", async () => {
    // Bookings names Memberships' holders as payers; Memberships requires Bookings (its passes
    // relate to bookings.service). Each passes, checked from either side.
    for (const name of ["bookings", "memberships"]) {
      const result = await checkExtensionDir(shipped(name));
      expect(result.issues, name).toEqual([]);
    }
  });
});

describe("cos ext", () => {
  it("says what is wrong when the directory is not an extension in a checkout", async () => {
    const out = io();
    expect(await runExt(["check", "/nonexistent-extension"], out)).toBe(2);
    expect(out.errors.join("\n")).toContain("No such directory");
  });

  it("prints its help for an unknown command", async () => {
    const out = io();
    expect(await runExt(["frobnicate", "x"], out)).toBe(2);
    expect(out.lines.join("\n")).toContain("cos ext check <dir>");
  });

  it("refuses to run tests when a tool has none", async () => {
    // The fixture declares an automation (followUp) and has no test files.
    const out = io();
    expect(await runExt(["test", fixture("missingtest")], out)).toBe(1);
    expect(out.lines.join("\n")).toContain("No test names automation followUp.");
  });
});

describe("locate", () => {
  const files = {
    "index.ts":
      "export default defineExtension({ objects: { deal: { fields: {} } }, automations: { wonDeal } });",
    "automations.ts": "export const wonDeal = defineAutomation({\n  steps: [],\n});",
  };

  it("finds the file that declares the named part of a path", () => {
    expect(locate(files, "objects.deal.titleField")).toEqual({ file: "index.ts", line: 1 });
    expect(
      locate({ "automations.ts": files["automations.ts"] }, "automations.wonDeal.steps.0.name"),
    ).toEqual({
      file: "automations.ts",
      line: 1,
    });
  });

  it("falls back to index.ts", () => {
    expect(locate(files, "nothing.here")).toEqual({ file: "index.ts" });
  });
});

describe("the staff roles an extension declares (stage 27, ADR 0436)", () => {
  it("is one line per role, with what it holds", () => {
    expect(rolesSummary({ id: "plain" })).toEqual([]);
    expect(
      rolesSummary({
        id: "ticketing",
        roles: {
          door: { label: "Door", permissions: ["ticketing:checkin"], read: ["ticketing.ticket"] },
        },
      }),
    ).toEqual([
      "This extension declares staff roles. An account given one may do this and nothing else:",
      "  role ticketing.door (Door): tools with ticketing:checkin; reads ticketing.ticket",
    ]);
  });

  it("says which objects a role reaches only for the people its holder looks after (ADR 0889)", () => {
    expect(
      rolesSummary({
        id: "programs",
        roles: {
          coach: {
            label: "Coach",
            permissions: ["programs:coach"],
            read: ["programs.session"],
            looksAfter: { "programs.session": "person", "programs.log": "person" },
          },
        },
      }),
    ).toEqual([
      "This extension declares staff roles. An account given one may do this and nothing else:",
      "  role programs.coach (Coach): tools with programs:coach; reads programs.session; only the people its holder looks after on programs.session, programs.log",
    ]);
  });

  it("says which objects a role reaches only through the records naming its holder (ADR 0755)", () => {
    expect(
      rolesSummary({
        id: "jobs",
        roles: {
          crew: {
            label: "Crew",
            permissions: ["jobs:crew"],
            read: [],
            mine: {
              "jobs.job": { through: "jobs.assignment" },
              "jobs.visit": { through: "jobs.assignment" },
            },
          },
        },
      }),
    ).toEqual([
      "This extension declares staff roles. An account given one may do this and nothing else:",
      "  role jobs.crew (Crew): tools with jobs:crew; reads nothing; only through the jobs.assignment records naming its holder on jobs.job, jobs.visit",
    ]);
  });

  it("names what each grantable permission opens, which adds up with a role (ADR 0600)", () => {
    expect(
      rolesSummary({
        id: "bookings",
        roles: { coach: { label: "Coach", permissions: ["bookings:coach"], read: [] } },
        grantable: ["bookings:desk"],
        tools: {
          day: { permission: ["bookings:coach", "bookings:desk"] },
          bookFor: { permission: "bookings:desk" },
          roster: { permission: "bookings:coach" },
        },
      }),
    ).toEqual([
      "This extension declares staff roles. An account given one may do this, and what it is granted below, and nothing else:",
      "  role bookings.coach (Coach): tools with bookings:coach; reads nothing",
      "Permissions an admin may grant one by one (to an account with a role too):",
      "  bookings:desk: tools day, bookFor",
    ]);
  });
});

describe("what an extension opens to people outside the org (stage 22, ADR 0414)", () => {
  it("is nothing for an extension that is for staff only", () => {
    expect(
      outsideSummary({ id: "plain", objects: { a: {} }, tools: { t: { risk: "write" } } }),
    ).toEqual([]);
    expect(outsideSummary(null)).toEqual([]);
  });

  it("is one line per object a customer sees and per tool they can call", () => {
    const lines = outsideSummary({
      id: "shop",
      objects: {
        order: { customer: { field: "buyer", read: ["status", "total"], write: [] } },
        supplier: {},
        event: {
          public: { read: ["name"], when: { field: "status", in: ["on_sale"] } },
          customerVia: { from: "shop.order", field: "event", read: ["name", "startsAt"] },
        },
        tier: {
          public: { read: ["price"], when: { via: "event", field: "status", in: ["on_sale"] } },
        },
      },
      tools: {
        cancel: {
          risk: "write",
          audiences: ["customer"],
          customerFields: { "shop.order": ["status"] },
        },
        report: { risk: "read", audiences: ["staff"] },
      },
    });
    expect(lines).toEqual([
      "This extension opens the host to people outside the org. Review these lines:",
      "  customers see shop.order where buyer is them: read status, total; write nothing",
      "  the public sees shop.event while status is on_sale: read name",
      "  customers see shop.event where their own shop.order's event points to it: read name, startsAt",
      "  the public sees shop.tier while its event's status is on_sale: read price",
      "  tool cancel (write) is open to customer, and may also set shop.order: status",
    ]);
  });
});
