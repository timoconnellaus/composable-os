// Stage 38 step 5: the Knowledge pack against @composable-os/sdk/testing's in-memory host. Its
// manifest passes the contract checks with a procedure that is staff-read and acknowledged and
// never public, and a help page the public reads as published; the tools only pass what they are
// given to the host's ack.* and record operations; the review reminder tells the owner, else the
// admins. apps/runner/test/knowledge.test.ts runs the same pack through the real host.
import { MUST_READ_SCHEMA } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import { notesToRichText } from "../tools.ts";

const PROCEDURE = "knowledge.procedure";
const HELP_PAGE = "knowledge.helppage";

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(records: Rows = {}, operations: Record<string, (input: never) => unknown> = {}) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const fake =
    (operation: string, answer: (input: Record<string, unknown>) => unknown) =>
    (input: Record<string, unknown>) => {
      calls.push({ operation, input });
      return answer(input);
    };
  const host = createTestHost(extension, {
    records,
    operations: {
      "ack.mine": fake("ack.mine", () => ({
        toRead: [
          {
            object: PROCEDURE,
            id: "prc_1",
            title: "Injuries",
            version: 2,
            publishedAt: "2026-11-01T00:00:00.000Z",
            since: "2026-11-01T00:00:00.000Z",
          },
          // Another pack's acknowledged record: not this pack's to list.
          {
            object: "other.thing",
            id: "oth_1",
            title: "Other",
            version: 1,
            publishedAt: "2026-11-01T00:00:00.000Z",
            since: "2026-11-01T00:00:00.000Z",
          },
        ],
        confirmed: [
          {
            object: PROCEDURE,
            id: "prc_2",
            title: "Opening up",
            version: 1,
            publishedAt: "2026-10-01T00:00:00.000Z",
            confirmedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      })),
      "ack.confirm": fake("ack.confirm", (input) => ({
        object: input.object,
        id: input.id,
        version: input.version,
        confirmedAt: "2026-11-25T09:00:00.000Z",
      })),
      "ack.status": fake("ack.status", (input) => ({
        object: input.object,
        id: input.id,
        title: "Injuries",
        version: 2,
        publishedAt: "2026-11-01T00:00:00.000Z",
        askedVersion: 2,
        everyone: false,
        roles: ["rostering.team"],
        people: [
          {
            account: "usr_sam",
            name: "Sam",
            email: "sam@example.test",
            confirmed: null,
            lastConfirmed: { version: 1, confirmedAt: "2026-10-02T00:00:00.000Z" },
            since: "2026-11-01T00:00:00.000Z",
          },
        ],
      })),
      "ack.overview": fake("ack.overview", () => ({
        items: [
          {
            object: PROCEDURE,
            id: "prc_1",
            title: "Injuries",
            version: 2,
            publishedAt: "2026-11-01T00:00:00.000Z",
            mustRead: 4,
            confirmed: 3,
          },
          {
            object: "other.thing",
            id: "oth_1",
            title: "Other",
            version: 1,
            publishedAt: "2026-11-01T00:00:00.000Z",
            mustRead: 1,
            confirmed: 0,
          },
        ],
      })),
      ...operations,
    },
  });
  return { host, calls };
}

describe("the Knowledge pack (test host)", () => {
  it("passes the contract checks: procedures for staff, help pages for the public", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { procedure, section, helppage, helptopic } = host.manifest.objects;
    // A procedure is never public: no public, signedIn or customer, so no edit can make it so.
    for (const object of [procedure, section]) {
      expect(object?.public).toBeUndefined();
      expect(object?.signedIn).toBeUndefined();
      expect(object?.customer).toBeUndefined();
    }
    expect(procedure?.publishable).toMatchObject({
      content: ["title", "summary", "body", "section"],
      slug: "slug",
      staffRead: true,
      acknowledge: {
        who: "mustRead",
        manage: "knowledge:manage",
        managed: ["reviewEvery"],
        owner: "owner",
      },
    });
    expect(procedure?.publishable?.acknowledge?.notices?.reminder?.afterDays).toBe(7);
    expect(JSON.stringify(procedure?.fields.mustRead?.schema)).toBe(
      JSON.stringify(MUST_READ_SCHEMA),
    );
    // Who must read and the review period are not content: they count at once.
    expect(procedure?.publishable?.content).not.toContain("mustRead");
    expect(procedure?.publishable?.content).not.toContain("reviewEvery");
    expect(procedure?.fields.reviewEvery).toMatchObject({ default: 12, min: 0 });
    expect(procedure?.fields.nextReview?.type).toBe("formula");
    // A help page is public in its published wording; its topic is public.
    expect(helppage?.publishable?.slug).toBe("slug");
    expect(helppage?.public?.read).toContain("body");
    expect(helptopic?.public?.read).toEqual(["name", "slug", "order", "icon"]);
    // Read status is restricted (admins and a grant); writing is grantable to a pack role.
    expect(host.manifest.restricted).toEqual(["knowledge:manage"]);
    expect(host.manifest.grantable).toEqual(["knowledge:manage", "knowledge:write"]);
    expect(host.manifest.roles).toEqual({});
  });

  it("gives the tools the reach the spec lists, and no more", () => {
    const { host } = hostWith();
    const t = host.manifest.tools;
    // A person's own, every staff account: the host's ack.* decides what is theirs.
    for (const name of ["toRead", "confirm"]) {
      expect(t[name], name).toMatchObject({ humanOnly: true, anyStaff: true });
      expect(t[name]?.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
    expect(t.readStatus).toMatchObject({ humanOnly: true, permission: "knowledge:manage" });
    expect(t.draftProcedure).toMatchObject({ permission: "knowledge:write", risk: "write" });
    expect(t.draftHelpPage).toMatchObject({ permission: "knowledge:write", risk: "write" });
    expect(t.draftProcedure?.humanOnly).toBeUndefined();
    // Only the help topics are open outside the staff.
    const open = Object.entries(t).filter(([, tool]) =>
      (tool.audiences ?? []).some((a) => a !== "staff"),
    );
    expect(open.map(([name]) => name)).toEqual(["helpTopics"]);
  });

  it("toRead lists my procedures from the host's ack.mine, and nothing of another pack", async () => {
    const { host, calls } = hostWith();
    const out = await host.runTool<{ toRead: { id: string }[]; confirmed: { id: string }[] }>(
      "toRead",
      {},
    );
    expect(calls).toEqual([{ operation: "ack.mine", input: {} }]);
    expect(out.toRead).toEqual([
      {
        id: "prc_1",
        title: "Injuries",
        version: 2,
        publishedAt: "2026-11-01T00:00:00.000Z",
        since: "2026-11-01T00:00:00.000Z",
      },
    ]);
    expect(out.confirmed.map((c) => c.id)).toEqual(["prc_2"]);
  });

  it("confirm passes the procedure and the version read to ack.confirm", async () => {
    const { host, calls } = hostWith();
    expect(await host.runTool("confirm", { id: "prc_1", version: 2 })).toEqual({
      id: "prc_1",
      version: 2,
      confirmedAt: "2026-11-25T09:00:00.000Z",
    });
    expect(calls).toEqual([
      { operation: "ack.confirm", input: { object: PROCEDURE, id: "prc_1", version: 2 } },
    ]);
  });

  it("readStatus reads one procedure's status, or every procedure's counts", async () => {
    const { host, calls } = hostWith();
    const one = await host.runTool<{ procedure: { people: { name: string }[] } }>("readStatus", {
      id: "prc_1",
    });
    expect(one.procedure.people.map((p) => p.name)).toEqual(["Sam"]);
    const all = await host.runTool<{ procedures: { id: string; confirmed: number }[] }>(
      "readStatus",
      {},
    );
    expect(all.procedures).toEqual([
      {
        id: "prc_1",
        title: "Injuries",
        version: 2,
        publishedAt: "2026-11-01T00:00:00.000Z",
        mustRead: 4,
        confirmed: 3,
      },
    ]);
    expect(calls.map((c) => c.operation)).toEqual(["ack.status", "ack.overview"]);
  });

  it("helpTopics lists the topics the public may read, in their order", async () => {
    // The seam answers what the public reads, in the order asked: the tool adds no filter.
    const { host, calls } = hostWith(
      {},
      {
        "public.list": () => ({
          items: [
            {
              id: "tpc_1",
              values: { name: "Booking", slug: "booking", order: 1, icon: "calendar" },
            },
            { id: "tpc_2", values: { name: "Payments", slug: "payments", order: 2 } },
          ],
          nextCursor: null,
        }),
      },
    );
    const out = await host.runTool<{ topics: unknown[] }>(
      "helpTopics",
      {},
      { caller: { kind: "public" } },
    );
    expect(out.topics).toEqual([
      { id: "tpc_1", name: "Booking", slug: "booking", order: 1, icon: "calendar" },
      { id: "tpc_2", name: "Payments", slug: "payments", order: 2, icon: null },
    ]);
    expect(calls).toEqual([]);
    expect(host.calls.find((c) => c.operation === "public.list")?.input).toEqual({
      object: "knowledge.helptopic",
      sort: { field: "order", direction: "asc" },
      limit: 100,
    });
  });

  it("draftProcedure writes a working copy from notes, and never who must read it", async () => {
    const { host } = hostWith({ "knowledge.section": [{ id: "sec_1", name: "Safety" }] });
    const made = await host.runTool<{ id: string; created: boolean }>("draftProcedure", {
      title: "Injuries",
      summary: "What we do when someone is hurt.",
      notes:
        "# First\nKeep calm.\n\n- Call the duty manager\n- Fetch the kit\n\n## Then\nWrite it up.",
      section: "sec_1",
    });
    expect(made.created).toBe(true);
    const record = host.records.get(PROCEDURE)?.get(made.id) as Record<string, unknown>;
    expect(record.title).toBe("Injuries");
    expect(record.section).toBe("sec_1");
    expect(record.mustRead ?? null).toBeNull();
    expect(record.body).toEqual({
      blocks: [
        { type: "heading", level: 2, content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Keep calm." }] },
        {
          type: "list",
          style: "bullet",
          items: [
            { content: [{ type: "text", text: "Call the duty manager" }] },
            { content: [{ type: "text", text: "Fetch the kit" }] },
          ],
        },
        { type: "heading", level: 3, content: [{ type: "text", text: "Then" }] },
        { type: "paragraph", content: [{ type: "text", text: "Write it up." }] },
      ],
    });
    // Again with the id: the same record's working copy, not a second one.
    const again = await host.runTool<{ id: string; created: boolean }>("draftProcedure", {
      id: made.id,
      title: "Injuries and accidents",
    });
    expect(again).toMatchObject({ id: made.id, created: false });
    expect(host.records.get(PROCEDURE)?.size).toBe(1);
  });

  it("draftHelpPage writes a help page's working copy in its topic", async () => {
    const { host } = hostWith({ "knowledge.helptopic": [{ id: "tpc_1", name: "Booking" }] });
    const made = await host.runTool<{ id: string }>("draftHelpPage", {
      title: "How do I cancel?",
      notes: "Open the app.\n\n1. Find the class\n2. Tap Cancel",
      topic: "tpc_1",
    });
    const record = host.records.get(HELP_PAGE)?.get(made.id) as Record<string, unknown>;
    expect(record).toMatchObject({ title: "How do I cancel?", topic: "tpc_1" });
    expect((record.body as { blocks: { type: string }[] }).blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "list",
    ]);
  });

  it("turns notes into rich text with no HTML", () => {
    expect(notesToRichText("<b>hi</b>")).toEqual({
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "<b>hi</b>" }] }],
    });
    expect(notesToRichText("")).toEqual({ blocks: [] });
  });

  it("reviewDue tells the owner on the date, else the admins", async () => {
    const { host } = hostWith({
      [PROCEDURE]: [
        { id: "prc_1", title: "Injuries", owner: "usr_owner", reviewEvery: 12 },
        { id: "prc_2", title: "Opening up" },
      ],
    });
    // The trigger: the next review date itself, a formula that is empty when never reviewed.
    const trigger = extension.automations?.reviewDue?.trigger;
    expect(trigger).toMatchObject({ type: "dateRelative", field: "nextReview", offsetDays: 0 });
    const owned = await host.runAutomation("reviewDue", {
      record: { object: PROCEDURE, id: "prc_1" },
      period: "2027-11-25",
    });
    expect(owned.undeclared).toEqual([]);
    expect(owned.notifications).toHaveLength(1);
    expect(JSON.stringify(owned.notifications[0])).toContain("owner");
    expect(JSON.stringify(owned.notifications[0])).toContain(
      "Time to check this is still right: Injuries",
    );
    const orphan = await host.runAutomation("reviewDue", {
      record: { object: PROCEDURE, id: "prc_2" },
      period: "2027-11-25",
    });
    expect(orphan.undeclared).toEqual([]);
    expect(JSON.stringify(orphan.notifications[0])).toContain("admin");
  });
});
