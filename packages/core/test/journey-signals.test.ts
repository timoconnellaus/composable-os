// Stage 53 step 2 (ADR 0802): journey signals. A shipped extension declares them; the contract
// refuses a bad declaration and a runtime extension's; the host records the last time each Person
// had each signal in the batch of the write that made it, for every path, with who stood behind
// the write (an AI's write records `ai`, a person's approval of it `person`), whether it was a bulk
// write, and never from an approval queue's dry run. One statement a batch however many records it
// writes; erase deletes a Person's rows and merge keeps the later of each.
import { env } from "cloudflare:workers";
import type { CrmDb } from "@composable-os/db";
import { type JourneySignalSpec, journeySignalFires, validateManifest } from "@composable-os/sdk";
import type { Compilable, CompiledQuery } from "kysely";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  invokeByName,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const ext = extId("sig");
const MEMBER = `${ext}.member`;

const OBJECTS = {
  member: {
    label: "Member",
    plural: "Members",
    titleField: "title",
    fields: {
      title: { type: "text", label: "Title" },
      person: { type: "relation", label: "Person", to: "person" },
      state: {
        type: "select",
        label: "State",
        options: [
          { value: "trial", label: "Trial" },
          { value: "active", label: "Active" },
          { value: "ended", label: "Ended" },
        ],
      },
    },
    states: {
      field: "state",
      initial: "trial",
      moves: [
        { from: "trial", to: "active", by: ["staff"] },
        { from: "active", to: "trial", by: ["staff"] },
        { from: ["trial", "active"], to: "ended", by: ["staff"], final: true },
      ],
    },
  },
} as const;

const SIGNALS = {
  joined: { label: "Joined", object: "member", person: "person" },
  converted: {
    label: "Converted",
    object: "member",
    person: "person",
    enters: ["active"],
    from: ["trial"],
  },
  ended: {
    label: "Ended",
    object: "member",
    person: "person",
    enters: ["ended"],
    created: false,
  },
} as const;

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(manifest(ext, { objects: OBJECTS, journeySignals: SIGNALS } as never));
});

afterEach(async () => {
  await setPreset("balanced");
});

const person = async () =>
  (
    (await invokeByName("person.create", { displayName: unique("P") }, context(admin))) as {
      id: string;
    }
  ).id;

const create = async (values: Record<string, unknown>, ctx = context(admin)) =>
  (
    (await invokeByName(
      "record.create",
      { object: MEMBER, values: { title: "M", ...values } },
      ctx,
    )) as {
      id: string;
    }
  ).id;

const update = (id: string, values: Record<string, unknown>, ctx = context(admin)) =>
  invokeByName("record.update", { object: MEMBER, id, values }, ctx);

interface SignalRow {
  signal: string;
  last_at: string;
  object_type: string;
  record_id: string;
  standing: string;
  bulk: number;
}

async function signals(personId: string): Promise<Record<string, SignalRow>> {
  const { results } = await env.DB.prepare(
    "SELECT signal, last_at, object_type, record_id, standing, bulk FROM core_person_signal WHERE person_id = ? ORDER BY signal",
  )
    .bind(personId)
    .all<SignalRow>();
  return Object.fromEntries(results.map((r) => [r.signal.slice(ext.length + 1), r]));
}

describe("the declaration", () => {
  const declare = (journeySignals: unknown, objects: unknown = OBJECTS) =>
    validateManifest({ id: "sigx", version: "1.0.0", contractVersion: 1, objects, journeySignals })
      .issues.filter((i) => i.path.startsWith("journeySignals"))
      .map((i) => i.path);

  it("is checked against the extension's own objects, states and Person field", () => {
    expect(declare(SIGNALS)).toEqual([]);
    expect(declare({ a: { label: "A", object: "nope" } })).toEqual(["journeySignals.a.object"]);
    expect(declare({ a: { label: "A", object: "member", person: "title" } })).toEqual([
      "journeySignals.a.person",
    ]);
    // No Person field named, and no customer field to default to.
    expect(declare({ a: { label: "A", object: "member" } })).toEqual(["journeySignals.a.person"]);
    expect(
      declare({ a: { label: "A", object: "member", person: "person", enters: ["gone"] } }),
    ).toEqual(["journeySignals.a.enters.0"]);
    expect(
      declare({
        a: { label: "A", object: "member", person: "person", enters: ["ended"], from: ["x"] },
      }),
    ).toEqual(["journeySignals.a.from.0"]);
    expect(
      declare({ a: { label: "A", object: "member", person: "person", from: ["trial"] } }),
    ).toEqual(["journeySignals.a.from"]);
    expect(
      declare({ a: { label: "A", object: "member", person: "person", created: false } }),
    ).toEqual(["journeySignals.a.created"]);
    expect(
      declare({ "Not-camel": { label: "A", object: "member", person: "person" } }),
    ).not.toEqual([]);
  });

  it("a runtime extension (written in the app) cannot declare one; a shipped one can", async () => {
    const id = extId("sigrt");
    const m = manifest(id, { objects: OBJECTS, journeySignals: SIGNALS } as never);
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, m, now, { source: "runtime" });
    expect(runtime.plan).toBeNull();
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "journeySignals.joined" }),
      ]),
    );
    const shipped = await checkManifest(db.query, id, m, now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });

  it("fires on a create, a move into a state, and only a move from the states it names", () => {
    const joined: JourneySignalSpec = SIGNALS.joined;
    const converted: JourneySignalSpec = SIGNALS.converted;
    expect(journeySignalFires(joined, "state", null, { state: "trial" })).toBe(true);
    expect(journeySignalFires(joined, "state", { state: "trial" }, { state: "active" })).toBe(
      false,
    );
    expect(journeySignalFires(converted, "state", { state: "trial" }, { state: "active" })).toBe(
      true,
    );
    expect(journeySignalFires(converted, "state", { state: "ended" }, { state: "active" })).toBe(
      false,
    );
    expect(journeySignalFires(converted, "state", { state: "active" }, { state: "active" })).toBe(
      false,
    );
    // Created straight into the state counts, unless `created: false`.
    expect(journeySignalFires(converted, "state", null, { state: "active" })).toBe(true);
    expect(journeySignalFires(SIGNALS.ended, "state", null, { state: "ended" })).toBe(false);
  });
});

describe("recording", () => {
  it("a create and a move write the Person's rows in the write's batch, one per signal", async () => {
    const p = await person();
    const id = await create({ person: p });
    const first = await signals(p);
    expect(Object.keys(first)).toEqual(["joined"]);
    expect(first.joined).toMatchObject({
      object_type: MEMBER,
      record_id: id,
      standing: "person",
      bulk: 0,
    });

    await update(id, { title: "Renamed" });
    expect(await signals(p)).toEqual(first);

    await update(id, { state: "active" });
    const moved = await signals(p);
    expect(Object.keys(moved)).toEqual(["converted", "joined"]);
    expect(moved.joined).toEqual(first.joined);

    // Back to trial and on again: still one row, its time the later one.
    await update(id, { state: "trial" });
    await update(id, { state: "active" });
    const again = await signals(p);
    expect(Object.keys(again)).toEqual(["converted", "joined"]);
    expect((again.converted?.last_at ?? "") >= (moved.converted?.last_at ?? "")).toBe(true);
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_signal WHERE person_id = ?",
    )
      .bind(p)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(2);

    await update(id, { state: "ended" });
    expect(Object.keys(await signals(p))).toEqual(["converted", "ended", "joined"]);
  });

  it("a record with no Person is nobody's signal", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_signal WHERE signal LIKE ?",
    )
      .bind(`${ext}.%`)
      .first<{ n: number }>();
    await create({});
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person_signal WHERE signal LIKE ?",
    )
      .bind(`${ext}.%`)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("an AI's write records the cause's standing as AI", async () => {
    await setPreset("autonomous");
    const p = await person();
    const id = await create({ person: p }, context(admin, { actor: "mcp" }));
    expect((await signals(p)).joined?.standing).toBe("ai");
    await update(id, { state: "active" }, context(admin, { actor: "assistant" }));
    expect((await signals(p)).converted?.standing).toBe("ai");
  });

  it("an AI's write a person approves records `person`; the queue's dry run records nothing", async () => {
    const p = await person();
    const id = await create({ person: p });
    await setPreset("cautious");
    const error = await update(id, { state: "active" }, context(admin, { actor: "mcp" })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PendingApprovalError);
    expect((await signals(p)).converted).toBeUndefined();
    const { pending } = error as PendingApprovalError;
    await invokeByName("approval.approve", { changeSetId: pending.changeSetId }, context(admin));
    expect((await signals(p)).converted?.standing).toBe("person");
  });

  it("a bulk write is marked, and costs one statement however many records it writes", async () => {
    const people = await Promise.all(Array.from({ length: 30 }, () => person()));
    const batches: string[][] = [];
    const counting: CrmDb = {
      query: db.query,
      async batch(statements: readonly (Compilable | CompiledQuery)[]) {
        batches.push(
          statements.map(
            (s) =>
              ("compile" in s && typeof s.compile === "function"
                ? s.compile()
                : (s as CompiledQuery)
              ).sql,
          ),
        );
        return db.batch(statements);
      },
    };
    await invokeByName(
      "record.createMany",
      { object: MEMBER, records: people.map((p) => ({ title: "Bulk", person: p })) },
      context(admin, { db: counting }),
    );
    const batch = batches.find((b) => b.some((sql) => sql.includes("core_person_signal")));
    expect(batch?.filter((sql) => sql.includes("core_person_signal"))).toHaveLength(1);
    for (const p of people) {
      expect((await signals(p)).joined).toMatchObject({ bulk: 1, standing: "person" });
    }
  });
});

describe("erase and merge", () => {
  it("erase deletes the Person's signals", async () => {
    const p = await person();
    await create({ person: p });
    expect(Object.keys(await signals(p))).toEqual(["joined"]);
    await invokeByName("person.erase", { id: p }, context(admin));
    expect(await signals(p)).toEqual({});
  });

  it("merge moves the duplicate's signals to the survivor, keeping the later of each", async () => {
    const survivor = await person();
    const merged = await person();
    // The survivor joined first; the duplicate joined later and converted.
    await create({ person: survivor });
    const later = await create({ person: merged });
    await update(later, { state: "active" });
    const theirs = await signals(merged);
    await invokeByName("person.merge", { survivorId: survivor, mergedId: merged }, context(admin));
    expect(await signals(merged)).toEqual({});
    const kept = await signals(survivor);
    expect(kept.joined?.record_id).toBe(later);
    expect(kept.joined?.last_at).toBe(theirs.joined?.last_at);
    expect(kept.converted?.record_id).toBe(later);
  });
});
