// Stage 34 step 5: the Offers pack against @composable-os/sdk/testing's in-memory host. Its
// manifest passes the contract checks with the `discount` behaviour declared for the host: live
// only through a person's tools, single-use codes kept as their hash, nothing public or a
// customer's. The tools only write a discount's terms, move it from a current read, and make or
// void codes; apps/runner/test/offers.test.ts runs the same pack in the real host, with orders
// priced by the host and paid through the fake provider.
import { CODE_ALPHABET, codeHash, isCodeHash } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { offersDashboards } from "../dashboards.ts";
import extension from "../index.ts";
import { BATCH_MAX, CODE, DISCOUNT, WRITE_CHUNK } from "../tools.ts";

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(
  records: Rows = {},
  sql: (input: Record<string, unknown>) => unknown = () => ({ rows: [] }),
) {
  const queries: Record<string, unknown>[] = [];
  const host = createTestHost(extension, {
    records,
    operations: {
      "query.sql": (input) => {
        queries.push(input);
        return sql(input);
      },
      // What is left after a void (the real host counts; apps/runner/test/offers.test.ts).
      "record.count": () => ({ count: 0, capped: false }),
    },
  });
  return { host, queries };
}

const PERSON = { kind: "staff" as const, userId: "usr_admin", name: "Ada Owner" };

describe("the Offers pack (test host)", () => {
  it("passes the contract checks, with discounts declared for the host", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { discount, code } = host.manifest.objects;
    expect(discount?.discount).toEqual({
      kind: "kind",
      percent: "percent",
      amount: "amount",
      live: ["active"],
      automatic: "automatic",
      code: "code",
      codes: {
        object: "code",
        discount: "discount",
        word: "word",
        uses: "uses",
        active: "active",
        hashed: true,
      },
      who: "who",
      organisations: "organisations",
      tag: "tag",
      objects: "appliesTo",
      from: "from",
      until: "until",
      totalUses: "totalUses",
      perPerson: "perPerson",
      minSpend: "minSpend",
    });
    // Made a draft; every move is the host's through a person's tool (ADR 0693).
    expect(discount?.states?.initial).toBe("draft");
    expect(discount?.states?.create).toBeUndefined();
    for (const move of discount?.states?.moves ?? []) {
      expect(move.by).toEqual(["host"]);
      expect(move.tools?.length).toBe(1);
    }
    // The codes' terms are the pack's tools' only: nobody types a code or its uses on the page.
    for (const field of ["word", "uses", "discount", "batch", "label"]) {
      expect(code?.fields[field]?.readOnly, field).toBe(true);
    }
  });

  it("opens nothing to customers or the public", () => {
    const { host } = hostWith();
    for (const object of Object.values(host.manifest.objects)) {
      expect(object.public).toBeUndefined();
      expect(object.signedIn).toBeUndefined();
      expect(object.customer).toBeUndefined();
      expect(object.customerVia).toBeUndefined();
    }
    for (const tool of Object.values(host.manifest.tools)) {
      expect(tool.audiences ?? ["staff"]).toEqual(["staff"]);
    }
  });

  it("makes a discount live, pauses and ends it only through a person's tools", () => {
    const { host } = hostWith();
    const tools = host.manifest.tools;
    for (const name of [
      "activateDiscount",
      "pauseDiscount",
      "endDiscount",
      "changeDiscount",
      "voidBatch",
    ]) {
      expect(tools[name]?.personApproves, name).toBe(true);
      expect(tools[name]?.permission, name).toBe("offers:manage");
    }
    // Codes are shown once, to a person: never asked for by the assistant, never kept.
    expect(tools.generateCodes).toMatchObject({
      humanOnly: true,
      permission: "offers:manage",
      risk: "bulk-write",
      redactResult: ["codes"],
    });
    // Codes typed to void are a person's at the screen: never in a request waiting for approval.
    expect(tools.voidCodes).toMatchObject({ humanOnly: true, redact: ["codes"] });
    // Drafting is anyone's: a draft applies to nobody.
    expect(tools.draftDiscount?.personApproves).toBeFalsy();
    expect(tools.draftDiscount?.humanOnly).toBeFalsy();
    expect(tools.discounts?.risk).toBe("read");
    expect(tools.codeBatches?.risk).toBe("read");
  });

  it("drafts a discount, then moves it from a current read", async () => {
    const { host } = hostWith();
    const draft = await host.runTool<{ id: string; state: string; code: string | null }>(
      "draftDiscount",
      { name: "January sale", kind: "percent", percent: 20, code: "january26", appliesTo: [] },
    );
    expect(draft).toMatchObject({ state: "draft", code: "january26" });
    const create = host.calls.find((c) => c.operation === "record.create");
    expect(create?.input).toMatchObject({ object: DISCOUNT });
    expect((create?.input as { values?: Record<string, unknown> })?.values?.state).toBeUndefined();

    const live = await host.runTool<{ state: string }>("activateDiscount", {
      discountId: draft.id,
    });
    expect(live.state).toBe("active");
    expect(host.calls.find((c) => c.operation === "record.update")?.input).toEqual({
      object: DISCOUNT,
      id: draft.id,
      values: { state: "active" },
      from: "draft",
    });
    expect(
      (await host.runTool<{ state: string }>("pauseDiscount", { discountId: draft.id })).state,
    ).toBe("paused");
    expect(
      (await host.runTool<{ state: string }>("activateDiscount", { discountId: draft.id })).state,
    ).toBe("active");
    expect(
      (await host.runTool<{ state: string }>("endDiscount", { discountId: draft.id })).state,
    ).toBe("ended");
  });

  it("changes a discount's terms, never its state", async () => {
    const { host } = hostWith({
      [DISCOUNT]: [{ id: "dis_1", name: "Members", kind: "percent", percent: 10, state: "active" }],
    });
    const changed = await host.runTool<{ percent: number; state: string; until: string | null }>(
      "changeDiscount",
      { discountId: "dis_1", percent: 15, until: "2027-01-31" },
    );
    expect(changed).toMatchObject({ percent: 15, state: "active", until: "2027-01-31" });
    await expect(host.runTool("changeDiscount", { discountId: "dis_1" })).rejects.toThrow(
      /Say what to change/,
    );
    await expect(
      host.runTool("changeDiscount", { discountId: "dis_1", state: "draft" }),
    ).rejects.toThrow();
  });

  it("makes a batch of single-use codes, kept only as their hash, in chunks", async () => {
    const { host } = hostWith({
      [DISCOUNT]: [{ id: "dis_1", name: "Newsletter", kind: "amount", amount: 10, state: "draft" }],
    });
    const out = await host.runTool<{
      made: number;
      complete: boolean;
      batch: string;
      codes: string[];
    }>(
      "generateCodes",
      { discountId: "dis_1", count: 120, usesPerCode: 1, batch: "Newsletter" },
      { caller: PERSON },
    );
    expect(out).toMatchObject({ made: 120, complete: true, batch: "Newsletter" });
    expect(new Set(out.codes).size).toBe(120);
    for (const code of out.codes) {
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{16}$`));
    }
    // Written 50 at a time, as hashes: no host call ever carries a code.
    const writes = host.calls.filter((c) => c.operation === "record.createMany");
    expect(writes.map((w) => (w.input as { records: unknown[] }).records.length)).toEqual([
      WRITE_CHUNK,
      WRITE_CHUNK,
      20,
    ]);
    const sent = JSON.stringify(host.calls);
    for (const code of out.codes) expect(sent).not.toContain(code);
    const stored = (
      host.calls.find((c) => c.operation === "record.createMany")?.input as
        | { records: Record<string, unknown>[] }
        | undefined
    )?.records[0];
    expect(stored).toMatchObject({
      discount: "dis_1",
      batch: "Newsletter",
      uses: 1,
      active: true,
      madeBy: "Ada Owner",
      label: "Newsletter #0001",
    });
    expect(isCodeHash(String(stored?.word))).toBe(true);
    expect(stored?.word).toBe(await codeHash(out.codes[0] as string));
    // The bound.
    await expect(
      host.runTool("generateCodes", { discountId: "dis_1", count: BATCH_MAX + 1 }),
    ).rejects.toThrow();
  });

  it("gives back the codes made when a batch stops part way", async () => {
    let writes = 0;
    const host = createTestHost(extension, {
      records: { [DISCOUNT]: [{ id: "dis_1", name: "Promo", kind: "percent", state: "draft" }] },
      operations: {
        "record.createMany": (input) => {
          writes++;
          if (writes === 2) throw Object.assign(new Error("D1 is busy"), { code: "internal" });
          return { ids: (input.records as unknown[]).map((_, i) => `cod_${writes}_${i}`) };
        },
      },
    });
    const out = await host.runTool<{ made: number; complete: boolean; problem: string | null }>(
      "generateCodes",
      { discountId: "dis_1", count: 150 },
    );
    expect(out).toMatchObject({ made: WRITE_CHUNK, complete: false });
    expect(out.problem).toMatch(/Stopped after 50 codes/);
  });

  it("gives the person the codes of a write that failed after the database kept it", async () => {
    let writes = 0;
    const kept = new Set<string>();
    const host = createTestHost(extension, {
      records: { [DISCOUNT]: [{ id: "dis_1", name: "Promo", kind: "percent", state: "draft" }] },
      operations: {
        "record.createMany": (input) => {
          writes++;
          for (const r of input.records as { word: string }[]) kept.add(r.word);
          // The second chunk is kept, and the answer is lost on the way back.
          if (writes === 2)
            throw Object.assign(new Error("The call timed out"), { code: "timeout" });
          return { ids: (input.records as unknown[]).map((_, i) => `cod_${writes}_${i}`) };
        },
        "record.list": (input) => {
          const words = ((input.filter as { and: { field: string; value: unknown }[] }).and.find(
            (f) => f.field === "word",
          )?.value ?? []) as string[];
          return {
            items: words.filter((w) => kept.has(w)).map((word) => ({ id: word, values: { word } })),
            nextCursor: null,
          };
        },
      },
    });
    const out = await host.runTool<{ made: number; complete: boolean; codes: string[] }>(
      "generateCodes",
      { discountId: "dis_1", count: 150 },
    );
    // Every code the database holds is in the answer: none is left that nobody holds.
    expect(out).toMatchObject({ made: 2 * WRITE_CHUNK, complete: false });
    expect(kept.size).toBe(2 * WRITE_CHUNK);
    expect(new Set(await Promise.all(out.codes.map((c) => codeHash(c))))).toEqual(kept);
  });

  it("refuses codes for an ended discount", async () => {
    const { host } = hostWith({
      [DISCOUNT]: [{ id: "dis_1", name: "Old", kind: "percent", state: "ended" }],
    });
    await expect(host.runTool("generateCodes", { discountId: "dis_1", count: 5 })).rejects.toThrow(
      /has ended/,
    );
    expect(host.calls.some((c) => c.operation === "record.createMany")).toBe(false);
  });

  it("voids codes by batch, or the codes a person types", async () => {
    const leaked = "ABCDEFGHJKLMNPQR";
    const { host } = hostWith({
      [CODE]: [
        { id: "cod_1", discount: "dis_1", batch: "A", word: await codeHash(leaked), active: true },
        {
          id: "cod_2",
          discount: "dis_1",
          batch: "A",
          word: await codeHash("X".repeat(16)),
          active: true,
        },
        {
          id: "cod_3",
          discount: "dis_1",
          batch: "B",
          word: await codeHash("Y".repeat(16)),
          active: true,
        },
      ],
    });
    expect(
      await host.runTool("voidCodes", { discountId: "dis_1", codes: [leaked.toLowerCase()] }),
    ).toEqual({ voided: 1, remaining: 0 });
    expect(await host.runTool("voidBatch", { discountId: "dis_1", batch: "A" })).toEqual({
      voided: 1,
      remaining: 0,
    });
    await expect(host.runTool("voidCodes", { discountId: "dis_1" })).rejects.toThrow();
  });

  it("lists discounts and code batches from the host's records of their uses", async () => {
    const { host, queries } = hostWith({}, (input) =>
      String(input.sql).includes("rec_x_offers_code")
        ? {
            rows: [
              { batch: "A", made: 50, working: 49, used: 3, uses: 1, made_by: "Ada", made_at: "x" },
            ],
          }
        : {
            rows: [
              {
                id: "dis_1",
                name: "Members",
                state: "active",
                kind: "price",
                amount: 15,
                automatic: 1,
                who: "members",
                applies_to: '["bookings.booking"]',
                used: 4,
                held: 1,
                given: 2000,
              },
            ],
          },
    );
    const list = await host.runTool<{ discounts: Record<string, unknown>[] }>("discounts", {
      state: "active",
    });
    expect(list.discounts[0]).toMatchObject({
      id: "dis_1",
      automatic: true,
      appliesTo: ["bookings.booking"],
      used: 4,
      held: 1,
      given: 2000,
    });
    expect(queries[0]?.params).toEqual(["active"]);
    const batches = await host.runTool<{ batches: Record<string, unknown>[] }>("codeBatches", {
      discountId: "dis_1",
    });
    expect(batches.batches).toEqual([
      { batch: "A", made: 50, working: 49, used: 3, usesPerCode: 1, madeBy: "Ada", madeAt: "x" },
    ]);
    // Never the codes: the query reads no word.
    expect(String(queries[1]?.sql)).not.toMatch(/\bword\b/);
  });

  it("declares its dashboard over the rec_* views only", () => {
    const { offersOverview } = offersDashboards;
    expect(offersOverview.widgets.length).toBeGreaterThan(0);
    for (const widget of offersOverview.widgets) {
      const sql = (widget as { sql?: string }).sql ?? "";
      expect(sql).not.toMatch(/\bcore_/);
      expect(sql).not.toMatch(/\bword\b/);
    }
  });
});
