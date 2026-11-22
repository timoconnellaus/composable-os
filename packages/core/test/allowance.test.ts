// Stage 32b step 5: the allowance behaviour (ADRs 0493 and 0494), proved with a fixture extension:
// classes (a time, a kind, a zone), two kinds of holder (a pass of N, per its own period, with
// kinds and an off-peak window; a weekly membership with no conditions) and a spender (a visit,
// spending on `booked`, giving back on `cancelled` and `moved`, keeping on `late`).
//
// What is checked: the limit for every actor and in the dry run; 20 spends at once; a refused
// batch leaving nothing; weeks and months across a change of clocks; conditions on kind and time
// of day; spending on a move into a state and giving back; moving a use to another spender; a
// holder not live at the spender's time; unlimited; which holder is spent first; merge and erase.
import { env } from "cloudflare:workers";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  allowancePeriodOf,
  type CustomerPrincipal,
  coreRegistry,
  createInvoker,
  createRegistry,
  type InvocationContext,
  localParts,
  PendingApprovalError,
  paidUpMoment,
  ValidationError,
  wallClockToIso,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const ext = extId("alw");
const KLASS = `${ext}.klass`;
const PASS = `${ext}.pass`;
const MEMBERSHIP = `${ext}.membership`;
const VISIT = `${ext}.visit`;

const { invoke } = createInvoker(createRegistry([...coreRegistry.list()]));

let admin: ActingUser;
let member: ActingUser;
const staff = (overrides: Partial<InvocationContext> = {}) => context(member, overrides);
const asMcp = () =>
  staff({
    actor: "mcp",
    origin: {
      surface: "mcp",
      clientId: "client-1",
      clientName: "Test client",
      sessionId: `alw_${unique()}`,
    },
  });

const KINDS = [
  { value: "spin", label: "Spin" },
  { value: "yoga", label: "Yoga" },
  { value: "open", label: "Open gym" },
];
const PERS = [
  { value: "total", label: "In all" },
  { value: "week", label: "A week" },
  { value: "month", label: "A month" },
];
const HOLDER_STATES = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "void", label: "Void" },
];
const holderStates: NonNullable<ExtensionManifest["objects"][string]["states"]> = {
  field: "state",
  initial: "active",
  moves: [
    { from: "active", to: "paused", by: ["staff", "host"] },
    { from: "paused", to: "active", by: ["staff", "host"] },
    { from: ["active", "paused"], to: "void", by: ["staff", "host"], final: true },
  ],
};

function fixture(id: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          startsAt: { type: "datetime", label: "Starts" },
          kind: { type: "select", label: "Kind", options: KINDS },
          zone: { type: "timezone", label: "Zone" },
        },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          uses: { type: "number", label: "Uses" },
          per: { type: "select", label: "Per", options: PERS },
          kinds: { type: "multiSelect", label: "Kinds", options: KINDS },
          offPeakFrom: { type: "number", label: "From minute" },
          offPeakUntil: { type: "number", label: "Until minute" },
          validFrom: { type: "datetime", label: "Valid from" },
          validUntil: { type: "date", label: "Valid until" },
          zone: { type: "timezone", label: "Zone" },
          state: { type: "select", label: "State", options: HOLDER_STATES },
        },
        states: holderStates,
        customer: { field: "person", read: ["name", "uses", "state"], write: [] },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: { field: "per" },
            from: "validFrom",
            until: "validUntil",
            zone: "zone",
            live: ["active"],
            spendsOn: {
              object: "visit",
              when: [
                { field: "kind", in: "kinds" },
                { field: "minute", atLeast: "offPeakFrom" },
                { field: "minute", below: "offPeakUntil" },
              ],
            },
          },
        },
      },
      membership: {
        label: "Membership",
        plural: "Memberships",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          uses: { type: "number", label: "Uses a week" },
          until: { type: "datetime", label: "Until" },
          state: { type: "select", label: "State", options: HOLDER_STATES },
        },
        states: holderStates,
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "week",
            until: "until",
            live: ["active"],
            spendsOn: { object: "visit" },
          },
        },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          klass: { type: "relation", label: "Class", to: `${id}.klass` },
          holder: { type: "text", label: "Paid by" },
          kind: { type: "select", label: "Kind", options: KINDS, readOnly: true },
          weekday: { type: "number", label: "Weekday", readOnly: true },
          minute: { type: "number", label: "Minute", readOnly: true },
          movedFrom: { type: "relation", label: "Moved from", to: `${id}.visit` },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "waiting", label: "Waiting" },
              { value: "booked", label: "Booked" },
              { value: "attended", label: "Attended" },
              { value: "late", label: "Late cancel" },
              { value: "cancelled", label: "Cancelled" },
              { value: "moved", label: "Moved" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "waiting",
          moves: [
            { from: "waiting", to: "booked", by: ["staff", "customer", "host"] },
            { from: "waiting", to: "cancelled", by: ["staff", "customer"], final: true },
            { from: "booked", to: "cancelled", by: ["staff", "customer"], final: true },
            { from: "booked", to: "late", by: ["staff", "customer"], final: true },
            { from: "booked", to: "attended", by: ["staff"] },
            { from: "attended", to: "booked", by: ["staff"] },
            { from: "booked", to: "moved", by: ["staff"], final: true },
          ],
        },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled", "moved"],
            at: "klass.startsAt",
            copy: { kind: "klass.kind" },
            local: { weekday: "weekday", minute: "minute", zone: "klass.zone" },
            movedFrom: { field: "movedFrom", state: "moved" },
          },
        },
      },
    },
  });
}

const SYDNEY = "Australia/Sydney";

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(fixture(ext));
});

async function create(object: string, values: Record<string, unknown>, ctx = staff()) {
  return (await invoke("record.create", { object, values }, ctx)).id as string;
}
async function person() {
  return (await invoke("person.create", { displayName: unique("Member") }, staff())).id as string;
}
async function klass(startsAt: string, kind = "spin", zone = SYDNEY) {
  return create(KLASS, { name: unique("Class"), startsAt, kind, zone });
}
async function pass(personId: string, values: Record<string, unknown> = {}) {
  return create(PASS, { name: unique("Pass"), person: personId, zone: SYDNEY, ...values });
}
async function book(
  personId: string,
  klassId: string,
  extra: Record<string, unknown> = {},
  ctx = staff(),
) {
  return create(
    VISIT,
    { name: unique("Visit"), person: personId, klass: klassId, state: "booked", ...extra },
    ctx,
  );
}
async function visitValues(id: string) {
  return (await invoke("record.get", { object: VISIT, id }, staff())).values as Record<
    string,
    unknown
  >;
}
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).details as Record<string, unknown>;
}
async function uses(where: string, ...params: unknown[]) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM core_allowance_use WHERE ${where} ORDER BY spent_at, id`,
  )
    .bind(...params)
    .all<Record<string, unknown>>();
  return results;
}
async function periodRow(holder: string, period: string) {
  return env.DB.prepare(
    "SELECT uses, used FROM core_allowance_period WHERE record_id = ? AND period = ?",
  )
    .bind(holder, period)
    .first<{ uses: number | null; used: number }>();
}
// Sydney: clocks go forward at 02:00 on Sunday 2026-10-04 (+10 to +11) and back at 03:00 on
// Sunday 2026-04-05 (+11 to +10).
describe("local time and periods", () => {
  it("a wall clock skipped by the change moves forward by the gap; one repeated is the first", () => {
    expect(wallClockToIso({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, SYDNEY)).toBe(
      "2026-10-03T16:30:00.000Z",
    );
    expect(localParts("2026-10-03T16:30:00.000Z", SYDNEY)).toMatchObject({ hour: 3, minute: 30 });
    expect(wallClockToIso({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, SYDNEY)).toBe(
      "2026-04-04T15:30:00.000Z",
    );
    expect(wallClockToIso({ year: 2026, month: 7, day: 1, hour: 6 }, SYDNEY)).toBe(
      "2026-06-30T20:00:00.000Z",
    );
    // paidUpMoment is unchanged by the move of its helpers.
    expect(paidUpMoment("2026-12-15", SYDNEY)).toBe("2026-12-14T13:00:00.000Z");
  });

  it("a week across the change runs Monday to Monday on the wall clock (167 hours)", () => {
    const week = allowancePeriodOf("2026-10-04T12:00:00.000Z", "week", SYDNEY);
    expect(week).toEqual({
      key: "week:2026-09-28",
      per: "week",
      startsAt: "2026-09-27T14:00:00.000Z",
      endsAt: "2026-10-04T13:00:00.000Z",
    });
    // 00:30 on Monday the 5th, local, is the next week.
    expect(allowancePeriodOf("2026-10-04T13:30:00.000Z", "week", SYDNEY).key).toBe(
      "week:2026-10-05",
    );
    // Sunday 23:30, local, is still this one.
    expect(allowancePeriodOf("2026-10-04T12:30:00.000Z", "week", SYDNEY).key).toBe(
      "week:2026-09-28",
    );
  });

  it("a month across the change starts and ends at local midnight", () => {
    expect(allowancePeriodOf("2026-04-15T00:00:00.000Z", "month", SYDNEY)).toEqual({
      key: "month:2026-04",
      per: "month",
      startsAt: "2026-03-31T13:00:00.000Z",
      endsAt: "2026-04-30T14:00:00.000Z",
    });
    expect(allowancePeriodOf("2026-12-31T13:30:00.000Z", "month", SYDNEY).key).toBe(
      "month:2027-01",
    );
    expect(allowancePeriodOf("2026-04-15T00:00:00.000Z", "total", SYDNEY).key).toBe("total");
  });
});

describe("the declaration's checks", () => {
  const issues = (m: ExtensionManifest) =>
    validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);

  it("the fixture passes", () => {
    expect(issues(fixture("alwok"))).toEqual([]);
  });

  it("refuses a holder whose terms a customer could write, or a spender without states", () => {
    const m = fixture("alwbad");
    const objects = m.objects as Record<string, Record<string, unknown>>;
    (objects.pass as Record<string, unknown>).customer = {
      field: "person",
      read: ["name", "uses"],
      write: ["uses"],
    };
    const visit = objects.visit as Record<string, unknown>;
    delete visit.states;
    (visit.fields as Record<string, Record<string, unknown>>).kind = {
      type: "select",
      label: "Kind",
      options: KINDS,
    };
    const found = issues(m).join("\n");
    expect(found).toContain("objects.pass.allowance.holds.uses");
    expect(found).toContain("A spender declares states");
    expect(found).toContain('"kind" must be a read-only field');
  });
});

describe("criterion 10: the limit", () => {
  it("3 a week: a fourth in the week is refused, for every actor; the next week spends; a return frees one; a late cancel keeps it", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 3, per: "week" });
    // Tuesday to Thursday of the week of Monday 2026-11-23, at 10:00 local (+11).
    const days = [
      "2026-11-23T23:00:00.000Z",
      "2026-11-24T23:00:00.000Z",
      "2026-11-25T23:00:00.000Z",
    ];
    const visits = [];
    for (const day of days) visits.push(await book(p, await klass(day)));
    const fourth = await klass("2026-11-26T23:00:00.000Z");
    const actors = [
      staff(),
      asMcp(),
      staff({ actor: "automation", origin: { surface: "system", automationId: "a1" } }),
      staff({
        actor: "extension",
        origin: { surface: "system" },
        extension: {
          id: ext,
          permissions: { read: [], write: [], operations: ["record.create"], modules: [] },
        },
      }),
    ];
    for (const ctx of actors) {
      expect(await refusal(book(p, fourth, {}, ctx))).toEqual({
        rule: "allowance",
        reason: "no_uses_left",
        object: PASS,
        record: holder,
        period: "week:2026-11-23",
        uses: 3,
        used: 3,
      });
    }
    expect(await periodRow(holder, "week:2026-11-23")).toEqual({ uses: 3, used: 3 });
    // The next week.
    await book(p, await klass("2026-11-30T23:00:00.000Z"));
    expect(await periodRow(holder, "week:2026-11-30")).toEqual({ uses: 3, used: 1 });
    // A cancel gives one back; the fourth then spends.
    await invoke(
      "record.update",
      { object: VISIT, id: visits[0], values: { state: "cancelled" } },
      staff(),
    );
    expect(await periodRow(holder, "week:2026-11-23")).toEqual({ uses: 3, used: 2 });
    const late = await book(p, fourth);
    // A late cancel keeps it: still full.
    await invoke("record.update", { object: VISIT, id: late, values: { state: "late" } }, staff());
    expect(await periodRow(holder, "week:2026-11-23")).toEqual({ uses: 3, used: 3 });
    expect((await uses("spender_id = ?", late))[0]).toMatchObject({ returned_at: null });
    // An attendance keeps it, and booking it back from attended spends nothing more.
    await invoke(
      "record.update",
      { object: VISIT, id: visits[1], values: { state: "attended" } },
      staff(),
    );
    await invoke(
      "record.update",
      { object: VISIT, id: visits[1], values: { state: "booked" } },
      staff(),
    );
    expect(await periodRow(holder, "week:2026-11-23")).toEqual({ uses: 3, used: 3 });
    expect(await uses("spender_id = ?", visits[1])).toHaveLength(1);
  });

  it("20 spends at once for 5 uses: exactly 5 visits are made, and nothing of the others", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 5, per: "total" });
    const classes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        klass(new Date(Date.UTC(2026, 11, 1 + i, 23)).toISOString()),
      ),
    );
    const outcomes = await Promise.all(
      classes.map((c) =>
        book(p, c).then(
          () => true,
          (e: unknown) => e,
        ),
      ),
    );
    const made = outcomes.filter((o) => o === true);
    expect(made).toHaveLength(5);
    for (const o of outcomes.filter((x) => x !== true)) {
      expect(o).toBeInstanceOf(ValidationError);
      expect((o as ValidationError).details).toMatchObject({
        rule: "allowance",
        reason: "no_uses_left",
      });
    }
    expect(await periodRow(holder, "total")).toEqual({ uses: 5, used: 5 });
    expect(await uses("record_id = ?", holder)).toHaveLength(5);
    const listed = await invoke("record.list", { object: VISIT, limit: 200 }, staff());
    expect(
      (listed.items as { values: Record<string, unknown> }[]).filter((r) => r.values.person === p),
    ).toHaveLength(5);
  });

  it("the dry run refuses at once and queues nothing; one that fits is queued and may be refused when approved", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "total" });
    const first = await klass("2026-12-10T23:00:00.000Z");
    const second = await klass("2026-12-11T23:00:00.000Z");
    await setPreset("cautious");
    try {
      const queued = await book(p, first, {}, asMcp()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(queued).toBeInstanceOf(PendingApprovalError);
      // Meanwhile staff spend the only use; approving the queued one is refused when it runs.
      await book(p, second);
      const out = (await invoke(
        "approval.approve",
        { actionIds: [(queued as PendingApprovalError).pending.actionId] },
        context(admin),
      )) as { results: { status: string; error: unknown }[] };
      expect(out.results[0]?.status).toBe("failed");
      expect(JSON.stringify(out.results[0]?.error)).toContain('"rule":"allowance"');
      // Now the dry run itself refuses.
      expect(await refusal(book(p, first, {}, asMcp()))).toMatchObject({
        reason: "no_uses_left",
        record: holder,
      });
    } finally {
      await setPreset("balanced");
    }
    expect(await periodRow(holder, "total")).toEqual({ uses: 1, used: 1 });
  });
});

describe("spending on a move into a state", () => {
  it("a waiting visit spends nothing; it spends when booked, and gives back when cancelled", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 2, per: "month" });
    const c = await klass("2026-12-02T23:00:00.000Z");
    const v = await create(VISIT, { name: unique("Wait"), person: p, klass: c });
    expect(await uses("spender_id = ?", v)).toHaveLength(0);
    expect((await visitValues(v)).holder).toBeNull();
    await invoke("record.update", { object: VISIT, id: v, values: { state: "booked" } }, staff());
    const values = await visitValues(v);
    // The host filled what it spent from, and what it copies: the kind, the local weekday and minute.
    expect(values).toMatchObject({ holder, kind: "spin", weekday: 4, minute: 600 });
    expect(await periodRow(holder, "month:2026-12")).toEqual({ uses: 2, used: 1 });
    await invoke(
      "record.update",
      { object: VISIT, id: v, values: { state: "cancelled" } },
      staff(),
    );
    expect(await periodRow(holder, "month:2026-12")).toEqual({ uses: 2, used: 0 });
    expect((await uses("spender_id = ?", v))[0]).toMatchObject({
      returned_by: "staff",
      spent_by: "staff",
      at: "2026-12-02T23:00:00.000Z",
    });
  });

  it("the use counts in the period of the class's time, not the time of booking", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "week" });
    await book(p, await klass("2027-01-05T23:00:00.000Z"));
    await book(p, await klass("2027-01-12T23:00:00.000Z"));
    expect(await periodRow(holder, "week:2027-01-04")).toEqual({ uses: 1, used: 1 });
    expect(await periodRow(holder, "week:2027-01-11")).toEqual({ uses: 1, used: 1 });
  });

  it("across a change of clocks: Sunday 23:30 and Monday 00:30 are two weeks", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "week" });
    await book(p, await klass("2026-10-04T12:30:00.000Z")); // Sun 4 Oct 23:30 (+11)
    await book(p, await klass("2026-10-04T13:30:00.000Z")); // Mon 5 Oct 00:30 (+11)
    expect(await periodRow(holder, "week:2026-09-28")).toEqual({ uses: 1, used: 1 });
    expect(await periodRow(holder, "week:2026-10-05")).toEqual({ uses: 1, used: 1 });
    // The Monday 00:00 that began the week, before the change (+10), is the same week.
    expect(await refusal(book(p, await klass("2026-09-27T14:00:00.000Z")))).toMatchObject({
      reason: "no_uses_left",
      period: "week:2026-09-28",
    });
  });

  it("a month across the clocks going back counts from local midnight on the 1st", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "month" });
    await book(p, await klass("2026-03-31T13:30:00.000Z")); // 1 Apr 00:30 (+11)
    expect(await periodRow(holder, "month:2026-04")).toEqual({ uses: 1, used: 1 });
    await book(p, await klass("2026-03-31T12:30:00.000Z")); // 31 Mar 23:30 (+11)
    expect(await periodRow(holder, "month:2026-03")).toEqual({ uses: 1, used: 1 });
    expect(
      await refusal(book(p, await klass("2026-04-30T13:30:00.000Z"))), // 30 Apr 23:30 (+10)
    ).toMatchObject({ period: "month:2026-04" });
  });
});

describe("what a holder pays for", () => {
  it("by kind and by time of day", async () => {
    const p = await person();
    const holder = await pass(p, {
      uses: null,
      per: "total",
      kinds: ["spin", "open"],
      offPeakFrom: 540,
      offPeakUntil: 960,
    });
    // Yoga is not in its kinds.
    expect(await refusal(book(p, await klass("2026-12-02T23:00:00.000Z", "yoga")))).toMatchObject({
      reason: "not_covered",
      record: holder,
    });
    // Spin at 18:00 local is outside 09:00 to 16:00; at 08:59 too; 16:00 is the end.
    for (const at of [
      "2026-12-03T07:00:00.000Z",
      "2026-12-02T21:59:00.000Z",
      "2026-12-03T05:00:00.000Z",
    ]) {
      expect(await refusal(book(p, await klass(at)))).toMatchObject({ reason: "not_covered" });
    }
    // 09:00 and 15:59 are in.
    await book(p, await klass("2026-12-02T22:00:00.000Z"));
    await book(p, await klass("2026-12-03T04:59:00.000Z", "open"));
    // A holder with no kinds and no window pays for anything.
    const any = await pass(p, { uses: null, per: "total" });
    await book(p, await klass("2026-12-03T07:00:00.000Z", "yoga"), { holder: any });
  });

  it("a caller cannot set the copied kind", async () => {
    const p = await person();
    await pass(p, { uses: null, per: "total", kinds: ["spin"] });
    const error = await book(p, await klass("2026-12-02T23:00:00.000Z", "yoga"), {
      kind: "spin",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("holders not live at the spender's time", () => {
  it("ended before the class, not valid yet, paused, void, someone else's, in the Trash", async () => {
    const p = await person();
    const other = await person();
    const c = await klass("2026-12-20T23:00:00.000Z"); // 21 Dec, 10:00 local
    // Valid until the 20th (a date: through that day).
    const ended = await pass(p, { uses: 5, per: "total", validUntil: "2026-12-20" });
    expect(await refusal(book(p, c, { holder: ended }))).toMatchObject({ reason: "ended" });
    // Valid until the 21st: the class's day is in.
    await invoke(
      "record.update",
      { object: PASS, id: ended, values: { validUntil: "2026-12-21" } },
      staff(),
    );
    await book(p, c, { holder: ended });
    const later = await pass(p, { uses: 5, per: "total", validFrom: "2026-12-22T00:00:00Z" });
    expect(await refusal(book(p, c, { holder: later }))).toMatchObject({
      reason: "not_yet_valid",
    });
    const paused = await pass(p, { uses: 5, per: "total" });
    await invoke(
      "record.update",
      { object: PASS, id: paused, values: { state: "paused" } },
      staff(),
    );
    expect(await refusal(book(p, c, { holder: paused }))).toMatchObject({ reason: "not_live" });
    const theirs = await pass(other, { uses: 5, per: "total" });
    expect(await refusal(book(p, c, { holder: theirs }))).toEqual({
      rule: "allowance",
      reason: "not_theirs",
    });
    // In the Trash, it cannot be spent; restored, it can.
    const trashed = await pass(p, { uses: 5, per: "total" });
    await invoke("record.delete", { object: PASS, id: trashed }, staff());
    expect(await refusal(book(p, c, { holder: trashed }))).toMatchObject({
      reason: "not_theirs",
    });
    await invoke("record.restore", { object: PASS, id: trashed }, staff());
    await book(p, c, { holder: trashed });
  });

  it("the database refuses a use the holder cannot pay, whatever the host read", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 5, per: "total" });
    await env.DB.prepare("UPDATE core_allowance SET live = 0 WHERE record_id = ?")
      .bind(holder)
      .run();
    expect(await refusal(book(p, await klass("2026-12-20T23:00:00.000Z")))).toMatchObject({
      rule: "allowance",
      reason: "not_live",
      record: holder,
    });
    expect(await periodRow(holder, "total")).toBeNull();
  });

  it("a person with nothing to spend is told so, and no visit is made", async () => {
    const p = await person();
    expect(await refusal(book(p, await klass("2026-12-20T23:00:00.000Z")))).toEqual({
      rule: "allowance",
      reason: "no_holder",
    });
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_allowance_use WHERE person_id = ?",
    )
      .bind(p)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });
});

describe("unlimited", () => {
  it("writes a use for every visit and counts them", async () => {
    const p = await person();
    const holder = await create(MEMBERSHIP, { name: unique("Unlimited"), person: p });
    for (let i = 0; i < 4; i += 1) await book(p, await klass(`2026-12-0${i + 1}T23:00:00.000Z`));
    expect(await uses("record_id = ?", holder)).toHaveLength(4);
    const { results } = await env.DB.prepare(
      "SELECT used, uses FROM core_allowance_period WHERE record_id = ?",
    )
      .bind(holder)
      .all<{ used: number; uses: number | null }>();
    expect(results.reduce((n, r) => n + r.used, 0)).toBe(4);
    expect(results.every((r) => r.uses === null)).toBe(true);
  });
});

describe("criterion 11: which holder is spent", () => {
  it("unlimited first; then the use that lapses first; then the next with room; or the one named", async () => {
    const p = await person();
    const c = () => klass("2027-02-02T23:00:00.000Z");
    const late = await pass(p, { uses: 5, per: "total", validUntil: "2027-06-30" });
    const soon = await pass(p, { uses: 1, per: "total", validUntil: "2027-03-31" });
    const first = await book(p, await c());
    expect((await visitValues(first)).holder).toBe(soon);
    // Soon is used up: the next with room.
    expect((await visitValues(await book(p, await c()))).holder).toBe(late);
    // A weekly membership's use lapses at the week's end, before either pass: it goes first.
    const weekly = await create(MEMBERSHIP, { name: unique("Two a week"), person: p, uses: 2 });
    expect((await visitValues(await book(p, await c()))).holder).toBe(weekly);
    // An unlimited one costs nothing: it goes before all.
    const unlimited = await create(MEMBERSHIP, { name: unique("Unlimited"), person: p });
    expect((await visitValues(await book(p, await c()))).holder).toBe(unlimited);
    // Named explicitly, that one is spent.
    expect((await visitValues(await book(p, await c(), { holder: late }))).holder).toBe(late);
    // The holder of a spent use cannot be changed under it.
    expect(
      await refusal(
        invoke("record.update", { object: VISIT, id: first, values: { holder: late } }, staff()),
      ),
    ).toMatchObject({ rule: "allowance", field: "holder" });
  });

  it("a paused membership is passed over for a pass; with nothing else it says why", async () => {
    const p = await person();
    const m = await create(MEMBERSHIP, { name: unique("Paused"), person: p });
    await invoke(
      "record.update",
      { object: MEMBERSHIP, id: m, values: { state: "paused" } },
      staff(),
    );
    expect(await refusal(book(p, await klass("2027-02-02T23:00:00.000Z")))).toMatchObject({
      reason: "not_live",
      record: m,
    });
    const holder = await pass(p, { uses: 1, per: "total" });
    expect((await visitValues(await book(p, await klass("2027-02-02T23:00:00.000Z")))).holder).toBe(
      holder,
    );
  });
});

describe("moving a use to another visit", () => {
  it("in one batch: the old visit is moved and gives its use back, the new one spends from the same holder", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "week" });
    const other = await pass(p, { uses: 5, per: "total", validUntil: "2027-12-31" });
    const a = await book(p, await klass("2027-03-02T23:00:00.000Z"), { holder });
    expect(await periodRow(holder, "week:2027-03-01")).toEqual({ uses: 1, used: 1 });
    const b = await book(p, await klass("2027-03-03T23:00:00.000Z"), { movedFrom: a });
    expect((await visitValues(a)).state).toBe("moved");
    expect((await visitValues(b)).holder).toBe(holder);
    expect(await periodRow(holder, "week:2027-03-01")).toEqual({ uses: 1, used: 1 });
    const [old] = await uses("spender_id = ?", a);
    const [moved] = await uses("spender_id = ?", b);
    expect(old?.returned_at).not.toBeNull();
    expect(moved).toMatchObject({ moved_from: old?.id, record_id: holder });
    expect(await uses("record_id = ?", other)).toHaveLength(0);
  });

  it("a move into a week with no use left is refused whole: the old visit stays booked", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 1, per: "week" });
    const a = await book(p, await klass("2027-03-09T23:00:00.000Z"));
    await book(p, await klass("2027-03-16T23:00:00.000Z"));
    expect(
      await refusal(book(p, await klass("2027-03-17T23:00:00.000Z"), { movedFrom: a })),
    ).toMatchObject({ reason: "no_uses_left", period: "week:2027-03-15" });
    expect((await visitValues(a)).state).toBe("booked");
    expect(await periodRow(holder, "week:2027-03-08")).toEqual({ uses: 1, used: 1 });
  });

  it("a visit holding a use cannot go to the Trash until it gives it back", async () => {
    const p = await person();
    await pass(p, { uses: 1, per: "total" });
    const v = await book(p, await klass("2027-03-09T23:00:00.000Z"));
    expect(await refusal(invoke("record.delete", { object: VISIT, id: v }, staff()))).toMatchObject(
      { rule: "allowance" },
    );
    await invoke(
      "record.update",
      { object: VISIT, id: v, values: { state: "cancelled" } },
      staff(),
    );
    await invoke("record.delete", { object: VISIT, id: v }, staff());
  });
});

describe("allowance.get and the record's values", () => {
  it("reads the period containing a time, and the holder shows used and left now", async () => {
    const p = await person();
    const holder = await pass(p, { uses: 3, per: "week" });
    const now = new Date();
    await book(p, await klass(new Date(now.getTime() + 60_000).toISOString()));
    const view = await invoke("allowance.get", { object: PASS, id: holder }, staff());
    expect(view).toMatchObject({ uses: 3, per: "week", live: true, personId: p });
    expect(view.period).toMatchObject({ used: 1, left: 2 });
    const record = await invoke("record.get", { object: PASS, id: holder }, staff());
    // At a week boundary the class may fall in the next week; the record reads the current one.
    expect(record.values.left).toBe(3 - (record.values.used as number));
    const next = await invoke(
      "allowance.get",
      { object: PASS, id: holder, at: new Date(now.getTime() + 14 * 86_400_000).toISOString() },
      staff(),
    );
    expect(next.period).toMatchObject({ used: 0, left: 3 });
  });
});

describe("a customer's allowance.get", () => {
  it("reads their own holder; anyone else's is not found", async () => {
    const p = await person();
    const other = await person();
    const mine = await pass(p, { uses: 2, per: "total" });
    const theirs = await pass(other, { uses: 2, per: "total" });
    const me: CustomerPrincipal = { kind: "customer", customerId: `cus_${unique()}`, personId: p };
    const own = await invoke("allowance.get", { object: PASS, id: mine }, { principal: me, db });
    expect(own).toMatchObject({ uses: 2, period: { key: "total", used: 0, left: 2 } });
    const error = await invoke(
      "allowance.get",
      { object: PASS, id: theirs },
      { principal: me, db },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as { code?: string })?.code).toBe("not_found");
  });
});

describe("a Person merged or erased", () => {
  it("a merge moves their holders' uses to the survivor; an erase removes them", async () => {
    const survivor = await person();
    const merged = await person();
    const holder = await pass(merged, { uses: 2, per: "total" });
    const v = await book(merged, await klass("2027-04-06T23:00:00.000Z"));
    await invoke(
      "person.merge",
      { survivorId: survivor, mergedId: merged, fields: {} },
      context(admin),
    );
    // The survivor spends what the merged Person held.
    await book(survivor, await klass("2027-04-07T23:00:00.000Z"));
    expect(await periodRow(holder, "total")).toEqual({ uses: 2, used: 2 });
    expect((await uses("record_id = ?", holder)).map((u) => u.person_id)).toEqual([
      survivor,
      survivor,
    ]);
    expect((await visitValues(v)).person).toBe(survivor);
    await invoke("person.erase", { id: survivor }, context(admin));
    expect(await uses("record_id = ?", holder)).toHaveLength(0);
    expect(await periodRow(holder, "total")).toBeNull();
    const row = await env.DB.prepare("SELECT 1 AS x FROM core_allowance WHERE record_id = ?")
      .bind(holder)
      .first();
    expect(row).toBeNull();
  });
});
