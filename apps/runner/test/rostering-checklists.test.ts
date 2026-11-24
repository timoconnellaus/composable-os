// Stage 45 step 4b: checklists (ADR 0650), on the shipped packs in the real host and sandbox. A
// duty carries a checklist; each of its shifts gets a run of it as it was; its person ticks it off
// (or someone who rosters, for them, with why); a done run never changes, for any writer; a run not
// done by its close is missed and the rosterers are told; a run is read by its person and those who
// roster only, never by another member of staff, a rec_* view, SQL, an export or an AI; and an
// assistant's checklist waits for a person. One test per part of acceptance criterion 13, the
// shift's life mid-run (reassigned, moved, cancelled, in the Trash, its person deactivated, a
// locked pay period), the operations' own guards, and what one call reads. The harness is
// rostering.test.ts's.
//
// Clocks: a tool's own calls read the real clock, so the shifts that are ticked are placed around
// now (started a few minutes ago); the minute cron is run with an explicit clock.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  newId,
  refreshSchemaRegistry,
  runChecklistDue,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  rostering: packFiles("rostering"),
};
// A shipped fixture pack whose tools call the host's checklist operations directly: one set open to
// anyone (no person at the screen), one a person's own (`humanOnly`) but with no Rostering
// permission. The operations' own guards must hold either way.
const RELAYED = ["forRecord", "tick", "complete", "runs", "correct"] as const;
const relayTool = (n: string, human: boolean) => `    ${n}${human ? "Human" : ""}: defineTool({
      description: "Test fixture: calls the host's checklist.${n} from another pack's tool.",
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      risk: "${n === "forRecord" || n === "runs" ? "read" : "write"}",${human ? "\n      humanOnly: true," : ""}
      handler: async (input, ctx) => ({ out: await ctx.ops.call("checklist.${n}", input) }),
    }),`;
files.checkrelay = {
  "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "checkrelay",
  version: "0.1.0",
  contractVersion: 1,
  label: "Checklist relay (fixture)",
  requires: ["rostering"],
  permissions: { operations: [${RELAYED.map((n) => `"checklist.${n}"`).join(", ")}], modules: ["ops"] },
  objects: {},
  tools: {
${RELAYED.map((n) => relayTool(n, false)).join("\n")}
${RELAYED.map((n) => relayTool(n, true)).join("\n")}
  },
});
`,
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "rostering", version: "0.1.0" },
    { id: "checkrelay", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Australia/Sydney";
const SHIFT = "rostering.shift";
const DUTY = "rostering.duty";
const MANAGE = "rostering:manage";

let admin: ActingUser;
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  ...extra,
});
const asUser = (user: ActingUser, extra: Partial<InvocationContext> = {}) =>
  staff({ user, ...extra });
const asAi = (user: ActingUser) =>
  asUser(user, { actor: "assistant", origin: { surface: "assistant" } });
const run = <T = Record<string, unknown>>(name: string, input: unknown, ctx: InvocationContext) =>
  invokeByName(name, input, ctx) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; message?: string; details?: Record<string, unknown> };
}
const rule = async (promise: Promise<unknown>) => {
  const e = await refusal(promise);
  const details = (e.details ?? {}) as Record<string, unknown>;
  const inner = (details.details ?? {}) as Record<string, unknown>;
  return String(details.rule ?? inner.rule ?? details.code ?? e.code);
};

/** A staff account with the role `role` and nothing else. */
async function account(name: string, role: "member" | "viewer" = "member"): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("staff")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, name, email, now, now, role)
    .run();
  return { id, email, name, role };
}
/** A staff account given a pack role by a human admin. */
async function fixedRole(name: string, role: string): Promise<ActingUser> {
  const user = await account(name, "member");
  await run("user.setPackRole", { id: user.id, role }, staff());
  return { ...user, role: "viewer" };
}

/** A checklist written by the admin, with its steps. */
async function template(
  steps: { text: string; required?: boolean; note?: boolean }[],
  name = unique("Close-down "),
): Promise<string> {
  return (await run<{ id: string }>("checklist.save", { name, steps }, staff())).id;
}
/** A duty with that checklist. */
const dutyWith = (checklist: string | null) =>
  create(DUTY, {
    name: unique("Cleaning "),
    place: "Main floor",
    ...(checklist ? { checklist } : {}),
  });
/** A one-off shift of `duty` starting `inMs` from now, an hour long, worked by `user`. */
async function shiftOf(duty: string, inMs: number, user: string | null, hours = 1) {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(SHIFT, {
    duty,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + hours * HOUR).toISOString(),
    timezone: ZONE,
    ...(user ? { staff: user } : {}),
  });
}
const cron = (at = new Date()) => runChecklistDue(db, { clock: () => at });
type View = {
  run: {
    id: string;
    state: string;
    account: string | null;
    template: { id: string; version: number };
    steps: {
      text: string;
      missed: boolean;
      history: { note: string | null; by: string }[];
      tick: {
        by: string;
        for: string;
        onBehalf: boolean;
        label: string;
        note: string | null;
      } | null;
    }[];
    corrections: { text: string }[];
  } | null;
  preview: { text: string }[] | null;
  canTick: boolean;
  onBehalf: boolean;
};
const view = (user: ActingUser, id: string) =>
  run<View>("x.rostering.checklist", { object: SHIFT, id }, asUser(user));
const tick = (user: ActingUser, id: string, step: number, extra: Record<string, unknown> = {}) =>
  run("x.rostering.tick", { object: SHIFT, id, step, state: "done", ...extra }, asUser(user));
const done = (user: ActingUser, id: string, extra: Record<string, unknown> = {}) =>
  run("x.rostering.checklistDone", { object: SHIFT, id, ...extra }, asUser(user));
const runRow = (record: string) =>
  env.DB.prepare("SELECT * FROM core_checklist_run WHERE object_type = ? AND record_id = ?")
    .bind(SHIFT, record)
    .first<{
      id: string;
      state: string;
      account_id: string | null;
      missed_steps: string | null;
      opens: number;
    }>();

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["rostering", "checkrelay"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
}, 120_000);

// --- Templates -------------------------------------------------------------------------------------

describe("templates (Settings → Checklists)", () => {
  it("are written by checklists:write, read by every staff account, and only an active one is picked", async () => {
    const id = await template([{ text: "Mop the floor" }, { text: "Note the stock", note: true }]);
    const got = await run<{ steps: { text: string; note: boolean }[]; version: number }>(
      "checklist.get",
      { id },
      staff(),
    );
    expect(got.steps).toEqual([
      { text: "Mop the floor", required: true, note: false },
      { text: "Note the stock", required: true, note: true },
    ]);
    const member = await account(unique("Reader Ro"));
    expect(
      (await run<{ items: { id: string }[] }>("checklist.list", {}, asUser(member))).items.map(
        (i) => i.id,
      ),
    ).toContain(id);
    // Writing one is checklists:write's: a member is refused until granted.
    expect(
      (
        await refusal(
          run("checklist.save", { name: "Mine", steps: [{ text: "x" }] }, asUser(member)),
        )
      ).code,
    ).toBe("forbidden");
    await run("user.setPermissions", { id: member.id, permissions: ["checklists:write"] }, staff());
    await run(
      "checklist.save",
      { name: unique("Granted "), steps: [{ text: "x" }] },
      asUser(member),
    );
    // An inactive one cannot be picked on a duty.
    await run(
      "checklist.save",
      { id, name: got.steps.length ? "Retired" : "", active: false, steps: got.steps },
      staff(),
    );
    expect(JSON.stringify(await refusal(dutyWith(id)))).toContain("no such checklist in use");
  });

  it("an assistant's checklist is not used until a person who may write checklists approves it", async () => {
    const ai = asAi(admin);
    const name = unique("Drafted by the assistant ");
    const queued = await refusal(
      run("checklist.save", { name, steps: [{ text: "Wipe the benches" }] }, ai),
    );
    expect(queued.code).toBe("pending_approval");
    const listed = await run<{ items: { name: string }[] }>("checklist.list", {}, staff());
    expect(listed.items.map((i) => i.name)).not.toContain(name);
    const actionId = String((queued.details as { actionId?: string }).actionId ?? "");
    expect(actionId).toMatch(/^pac_/);
    // A member who may not write checklists cannot approve it, nor can an AI.
    const member = await account(unique("Approver Ap"));
    await refusal(run("approval.approve", { actionIds: [actionId] }, asUser(member)));
    await refusal(run("approval.approve", { actionIds: [actionId] }, ai));
    await run("approval.approve", { actionIds: [actionId] }, staff());
    const after = await run<{ items: { name: string }[] }>("checklist.list", {}, staff());
    expect(after.items.map((i) => i.name)).toContain(name);
  });
});

// --- A run of the template as it was ---------------------------------------------------------------

describe("a duty with a checklist gives each of its shifts a run of it as it was", () => {
  it("the cron makes the run a day ahead, copying the steps; a template changed later changes no run made", async () => {
    const id = await template([{ text: "Empty the bins" }, { text: "Lock the back door" }]);
    const duty = await dutyWith(id);
    const person = await account(unique("Runner Ru"));
    const soon = await shiftOf(duty, 5 * HOUR, person.id);
    const later = await shiftOf(duty, 3 * DAY, person.id);
    const noList = await shiftOf(await dutyWith(null), 6 * HOUR, person.id);
    await cron();
    expect(await runRow(soon)).toMatchObject({ state: "open", account_id: person.id });
    expect(await runRow(later)).toBeNull(); // Not within a day yet.
    expect(await runRow(noList)).toBeNull(); // No checklist, no run.
    await run(
      "checklist.save",
      { id, name: "Changed", steps: [{ text: "Something else" }] },
      staff(),
    );
    const v = await view(person, soon);
    expect(v.run?.steps.map((s) => s.text)).toEqual(["Empty the bins", "Lock the back door"]);
    expect(v.run?.template.version).toBe(1);
    // A shift without a run yet previews the steps as they are now.
    expect((await view(person, later)).preview?.map((s) => s.text)).toEqual(["Something else"]);
    // The roster says it has one, by name, to everyone; how it is going to its person and rosterers.
    const colleague = await account(unique("Colleague Co"));
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(Date.now() + 5 * HOUR),
    );
    const states = async (user: ActingUser, ai = false) =>
      (
        await run<{
          shifts: { id: string; checklist: { name: string; state: string | null } | null }[];
        }>("x.rostering.week", { from: date, to: date }, ai ? asAi(user) : asUser(user))
      ).shifts.find((s) => s.id === soon)?.checklist;
    expect(await states(admin)).toEqual({ name: expect.any(String), state: "not_started" });
    expect(await states(person)).toEqual({ name: expect.any(String), state: "not_started" });
    expect(await states(colleague)).toEqual({ name: expect.any(String), state: null });
    expect(await states(admin, true)).toEqual({ name: expect.any(String), state: null });
    // And the later shift's run, when made, copies the steps as they are then.
    await cron(new Date(Date.now() + 2 * DAY + HOUR));
    const made = await runRow(later);
    expect(made?.state).toBe("open");
    expect((await view(person, later)).run?.steps.map((s) => s.text)).toEqual(["Something else"]);
  });
});

// --- Who ticks ---------------------------------------------------------------------------------------

describe("who ticks", () => {
  it("the shift's person ticks their own; a colleague cannot read or tick it; an AI actor is refused", async () => {
    const duty = await dutyWith(await template([{ text: "Sweep" }, { text: "Lights off" }]));
    const person = await account(unique("Ticker Ti"));
    const colleague = await account(unique("Colleague Ca"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    // Before the cron: the first tick makes the run.
    expect((await view(person, s)).canTick).toBe(true);
    await tick(person, s, 0);
    const v = await view(person, s);
    expect(v.run?.steps[0]?.tick).toMatchObject({
      by: person.id,
      for: person.id,
      onBehalf: false,
      label: `Ticked by ${person.name}`,
    });
    expect(await rule(view(colleague, s))).toBe("not_found");
    expect(await rule(tick(colleague, s, 1))).toBe("not_found");
    // An AI never ticks or reads it, for anyone.
    expect(
      (
        await refusal(
          run("x.rostering.tick", { object: SHIFT, id: s, step: 1, state: "done" }, asAi(person)),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (await refusal(run("x.rostering.checklist", { object: SHIFT, id: s }, asAi(admin)))).code,
    ).toBe("forbidden");
    // Not yet open: a shift tomorrow is not ticked today.
    const tomorrow = await shiftOf(duty, DAY, person.id);
    expect(await rule(tick(person, tomorrow, 0))).toBe("checklist_window");
  });

  it("someone who rosters ticks for the person with a reason, kept as 'ticked by X for Y' everywhere", async () => {
    const duty = await dutyWith(await template([{ text: "Restock towels" }, { text: "Bins out" }]));
    const person = await account(unique("Person Pe"));
    const rosterer = await account(unique("Rosterer Ro"));
    await run("user.setPermissions", { id: rosterer.id, permissions: [MANAGE] }, staff());
    const s = await shiftOf(duty, -20 * MINUTE, person.id);
    expect(await rule(tick(rosterer, s, 0))).toBe("checklist_for_why");
    await tick(rosterer, s, 0, { forWhy: "Worked by another on the day" });
    const v = await view(person, s);
    const t = v.run?.steps[0]?.tick;
    expect(t).toMatchObject({ by: rosterer.id, for: person.id, onBehalf: true });
    expect(t?.label).toBe(`Ticked by ${rosterer.name} for ${person.name}`);
    // The rosterers' view counts it as a tick for the person, never as the person's own.
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
    const runs = await run<{ runs: { record: string; onBehalf: number; ticked: number }[] }>(
      "x.rostering.checklistRuns",
      { from: date, to: date },
      asUser(rosterer),
    );
    expect(runs.runs.find((r) => r.record === s)).toMatchObject({ onBehalf: 1, ticked: 1 });
    // A member who does not roster cannot read everyone's.
    expect(
      await rule(run("x.rostering.checklistRuns", { from: date, to: date }, asUser(person))),
    ).toBe("forbidden");
  });

  it("a step asking for a note is not done without one; not done needs why", async () => {
    const duty = await dutyWith(
      await template([
        { text: "Count the floats", note: true },
        { text: "Optional", required: false },
      ]),
    );
    const person = await account(unique("Noter No"));
    const s = await shiftOf(duty, -5 * MINUTE, person.id);
    expect(await rule(tick(person, s, 0))).toBe("checklist_note_needed");
    expect(await rule(tick(person, s, 0, { state: "not_done" }))).toBe("checklist_why");
    await tick(person, s, 0, { note: "Two floats short" });
    // The note is the person's and the rosterers': never in the audit log, a tool run or a notice.
    for (const query of [
      "SELECT input || coalesce(result, '') || coalesce(error, '') AS t FROM core_audit",
      "SELECT coalesce(error, '') || logs || operations AS t FROM core_extension_runs",
      "SELECT title || coalesce(body, '') AS t FROM core_notifications",
    ]) {
      const { results } = await env.DB.prepare(query).all<{ t: string }>();
      expect(results.map((r) => r.t).join("\n"), query).not.toContain("Two floats short");
    }
    expect((await view(person, s)).run?.steps[0]?.tick?.note).toBe("Two floats short");
    // Done once the required ones are ticked (the optional one need not be).
    await done(person, s);
    expect((await runRow(s))?.state).toBe("done");
  });
});

// --- Done is final --------------------------------------------------------------------------------

describe("a completed run refuses every change to its ticks, for everyone", () => {
  it("through the tools, for its person and a rosterer, and by every SQL statement shape", async () => {
    const duty = await dutyWith(await template([{ text: "Close the till" }, { text: "Alarm on" }]));
    const person = await account(unique("Closer Cl"));
    const s = await shiftOf(duty, -15 * MINUTE, person.id);
    // Not done until every required step is ticked.
    await tick(person, s, 0);
    expect(await rule(done(person, s))).toBe("checklist_incomplete");
    await tick(person, s, 1);
    await done(person, s);
    const r = await runRow(s);
    expect(r?.state).toBe("done");
    expect(await rule(tick(person, s, 0, { state: "clear" }))).toBe("checklist_closed");
    expect(await rule(tick(admin, s, 0, { state: "not_done", why: "x", forWhy: "y" }))).toBe(
      "checklist_closed",
    );
    expect(await rule(done(person, s))).toBe("checklist_closed");
    const id = r?.id as string;
    const tickId = (
      await env.DB.prepare("SELECT id FROM core_checklist_tick WHERE run_id = ? LIMIT 1")
        .bind(id)
        .first<{ id: string }>()
    )?.id as string;
    const now = new Date().toISOString();
    const otherPerson = await account(unique("Other Ot"));
    const other = await shiftOf(duty, -14 * MINUTE, otherPerson.id);
    await tick(otherPerson, other, 0);
    for (const statement of [
      ["UPDATE core_checklist_tick SET note = 'changed' WHERE run_id = ?", [id]],
      [
        "UPDATE OR REPLACE core_checklist_tick SET position = 1 WHERE run_id = ? AND position = 0",
        [id],
      ],
      ["DELETE FROM core_checklist_tick WHERE run_id = ?", [id]],
      [
        "INSERT OR REPLACE INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'done', 'x', 'x', 0, ?)",
        [tickId, id, now],
      ],
      [
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'done', 'x', 'x', 0, ?) ON CONFLICT (id) DO UPDATE SET note = 'x'",
        [tickId, id, now],
      ],
      [
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES ('ckt_new', ?, 0, 'cleared', 'x', 'x', 0, ?)",
        [id, now],
      ],
      ["UPDATE core_checklist_run SET state = 'open', closed_at = NULL WHERE id = ?", [id]],
      ["UPDATE core_checklist_run SET steps = '[]' WHERE id = ?", [id]],
      ["UPDATE core_checklist_run SET account_id = 'someone' WHERE id = ?", [id]],
      ["UPDATE core_checklist_run SET missed_steps = '[0]' WHERE id = ?", [id]],
      ["UPDATE OR REPLACE core_checklist_run SET record_id = 'elsewhere' WHERE id = ?", [id]],
      ["UPDATE OR REPLACE core_checklist_run SET account_id = 'someone' WHERE id = ?", [id]],
      // An open run moved onto the closed run's record by UPDATE OR REPLACE.
      [
        "UPDATE OR REPLACE core_checklist_run SET record_id = ? WHERE object_type = ? AND record_id = ?",
        [s, SHIFT, other],
      ],
      ["DELETE FROM core_checklist_run WHERE id = ?", [id]],
      [
        "INSERT OR REPLACE INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps, opens, closes, state, made_at) VALUES (?, 'x', 'y', 'c', 1, 'n', '[{}]', 0, 0, 'open', ?)",
        [id, now],
      ],
      [
        "INSERT OR REPLACE INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps, opens, closes, state, made_at) VALUES ('ckr_other', ?, ?, 'c', 1, 'n', '[{}]', 0, 0, 'open', ?)",
        [SHIFT, s, now],
      ],
    ] as const) {
      const error = await env.DB.prepare(statement[0])
        .bind(...statement[1])
        .run()
        .then(
          () => null,
          (e: Error) => e.message,
        );
      expect([statement[0], error]).toEqual([
        statement[0],
        expect.stringMatching(/core_checklist_(closed|fixed)/),
      ]);
    }
    const v = await view(person, s);
    expect(v.run?.state).toBe("done");
    expect(v.run?.steps.every((x) => x.tick?.by === person.id && x.tick.note === null)).toBe(true);
    // A correction is a note beside it, by someone who rosters, never a change to a tick.
    await run("x.rostering.checklistCorrect", { run: id, text: "The alarm was set late" }, staff());
    const noteId = (
      await env.DB.prepare("SELECT id FROM core_checklist_note WHERE run_id = ?")
        .bind(id)
        .first<{ id: string }>()
    )?.id as string;
    for (const statement of [
      [
        "INSERT OR REPLACE INTO core_checklist_note (id, run_id, text, written_by, written_at) VALUES (?, ?, 'rewritten', 'x', ?)",
        [noteId, id, now],
      ],
      [
        "INSERT INTO core_checklist_note (id, run_id, text, written_by, written_at) VALUES (?, ?, 'rewritten', 'x', ?) ON CONFLICT (id) DO UPDATE SET text = 'rewritten'",
        [noteId, id, now],
      ],
      ["UPDATE OR REPLACE core_checklist_note SET text = 'x' WHERE id = ?", [noteId]],
      ["UPDATE core_checklist_note SET text = 'x' WHERE id = ?", [noteId]],
      ["DELETE FROM core_checklist_note WHERE id = ?", [noteId]],
    ] as const) {
      const error = await env.DB.prepare(statement[0])
        .bind(...statement[1])
        .run()
        .then(
          () => null,
          (e: Error) => e.message,
        );
      expect([statement[0], error]).toEqual([
        statement[0],
        expect.stringMatching(/core_checklist_fixed/),
      ]);
    }
    expect((await view(person, s)).run?.corrections.map((c) => c.text)).toEqual([
      "The alarm was set late",
    ]);
    expect(
      await rule(run("x.rostering.checklistCorrect", { run: id, text: "x" }, asUser(person))),
    ).toBe("forbidden");
  });
});

// --- Missed -----------------------------------------------------------------------------------------

describe("a run not done by its close and grace is missed", () => {
  it("with the steps nobody ticked, and the rosterers are told (a person's notice)", async () => {
    const name = unique("Opening up ");
    const duty = await dutyWith(await template([{ text: "Unlock" }, { text: "Heating on" }], name));
    const person = await account(unique("Misser Mi"));
    // Ended 1 h 50 min ago: inside its grace for ten more minutes.
    const s = await shiftOf(duty, -(2 * HOUR + 50 * MINUTE), person.id);
    await cron();
    await tick(person, s, 0);
    await cron(new Date(Date.now() + 11 * MINUTE));
    const r = await runRow(s);
    expect(r?.state).toBe("missed");
    expect(JSON.parse(r?.missed_steps ?? "[]")).toEqual([1]);
    const v = await view(person, s);
    expect(v.run?.steps.map((x) => x.missed)).toEqual([false, true]);
    const told = await env.DB.prepare(
      "SELECT user_id, title, body, human_only FROM core_notifications WHERE title LIKE ?",
    )
      .bind(`%${name}%`)
      .all<{ user_id: string; body: string; human_only: number }>();
    expect(told.results.map((n) => n.user_id)).toContain(admin.id);
    expect(
      told.results.every((n) => n.body.includes("Heating on") && !n.body.includes("Unlock")),
    ).toBe(true);
    expect(told.results.every((n) => n.human_only === 1)).toBe(true);
    // Missed is closed too.
    expect(await rule(tick(person, s, 1))).toMatch(/checklist_(closed|window)/);
  });
});

// --- Who reads -----------------------------------------------------------------------------------------

describe("a run is read by its person and those who roster only", () => {
  it("never by another member of staff, a team account, a rec_* view, SQL, an export or an AI", async () => {
    const duty = await dutyWith(await template([{ text: "Check the first aid kit" }]));
    const cleaner = await fixedRole(unique("Cleaner Cy"), "rostering.team");
    const colleague = await fixedRole(unique("Cleaner Co"), "rostering.team");
    const s = await shiftOf(duty, -30 * MINUTE, cleaner.id);
    await tick(cleaner, s, 0, { note: "Plasters low" });
    expect((await view(cleaner, s)).run?.steps[0]?.tick?.note).toBe("Plasters low");
    expect((await view(admin, s)).run?.steps[0]?.tick?.note).toBe("Plasters low");
    expect(await rule(view(colleague, s))).toBe("not_found");
    // In no rec_* view: no view of the database names a checklist table.
    const views = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'view' AND sql LIKE '%core_checklist%'",
    ).all<{ name: string }>();
    expect(views.results).toEqual([]);
    // So no SQL a member may run, and no export of any object, reaches it.
    const sql = await refusal(
      run(
        "query.sql",
        { sql: "SELECT note FROM core_checklist_tick" },
        asUser(await account(unique("Sql Sq"))),
      ),
    );
    expect(JSON.stringify(sql)).not.toContain("Plasters low");
    const assistant = await refusal(
      run("x.rostering.checklist", { object: SHIFT, id: s }, asAi(cleaner)),
    );
    expect(assistant.code).toBe("forbidden");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
    expect(
      (await refusal(run("x.rostering.checklistRuns", { from: date, to: date }, asAi(admin)))).code,
    ).toBe("forbidden");
  });
});

// --- The shift's life mid-run -------------------------------------------------------------------------

describe("the shift changes mid-run", () => {
  it("reassigned: the new person continues, the ticks keep who made them, the first person still reads what they did", async () => {
    const duty = await dutyWith(await template([{ text: "Fold mats" }, { text: "Vacuum" }]));
    const first = await account(unique("First Fi"));
    const second = await account(unique("Second Se"));
    const s = await shiftOf(duty, -40 * MINUTE, first.id);
    await tick(first, s, 0);
    await run("x.rostering.assign", { object: SHIFT, id: s, account: second.id }, staff());
    expect(await rule(tick(first, s, 1))).toBe("checklist_not_yours");
    await tick(second, s, 1);
    await cron();
    const v = await view(second, s);
    expect(v.run?.account).toBe(second.id);
    expect(v.run?.steps.map((x) => x.tick?.by)).toEqual([first.id, second.id]);
    expect((await view(first, s)).run?.steps[0]?.tick?.by).toBe(first.id);
    await done(second, s);
  });

  it("moved later: its window moves with it; cancelled or in the Trash: no ticks, closed as cancelled at its close", async () => {
    const duty = await dutyWith(await template([{ text: "Water the plants" }]));
    const person = await account(unique("Mover Mo"));
    const moved = await shiftOf(duty, -(2 * HOUR + 55 * MINUTE), person.id);
    await cron();
    // Moved to now: its window is now, so the cron does not miss it.
    const startsAt = new Date(Date.now() - 5 * MINUTE).toISOString();
    await run(
      "record.update",
      {
        object: SHIFT,
        id: moved,
        values: { startsAt, endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString() },
      },
      staff(),
    );
    await cron(new Date(Date.now() + 10 * MINUTE));
    expect((await runRow(moved))?.state).toBe("open");
    await tick(person, moved, 0);
    // Cancelled mid-run: no ticks; at its close and grace, cancelled (not missed).
    const cancelled = await shiftOf(
      duty,
      -(2 * HOUR + 55 * MINUTE),
      (await account(unique("Can Ca"))).id,
    );
    await cron();
    await run(
      "record.update",
      { object: SHIFT, id: cancelled, values: { state: "cancelled" } },
      staff(),
    );
    const trashed = await shiftOf(
      duty,
      -(2 * HOUR + 55 * MINUTE),
      (await account(unique("Tra Tr"))).id,
    );
    await cron();
    await run("record.delete", { object: SHIFT, id: trashed }, staff());
    await cron(new Date(Date.now() + 10 * MINUTE));
    expect((await runRow(cancelled))?.state).toBe("cancelled");
    expect((await runRow(trashed))?.state).toBe("cancelled");
    // The Trash's purge of a shift with a closed run is not refused by the run's triggers.
    await env.DB.prepare(`DELETE FROM ${"x_rostering_shift"} WHERE id = ?`).bind(trashed).run();
  });

  it("its person deactivated mid-run: the shift under way keeps them, someone who rosters ticks for them", async () => {
    const duty = await dutyWith(await template([{ text: "Lock up" }]));
    const leaver = await account(unique("Leaver Le"));
    const s = await shiftOf(duty, -25 * MINUTE, leaver.id);
    await tick(leaver, s, 0);
    const asked = await run("user.deactivate", { id: leaver.id }, staff()).then(
      () => null,
      (e: { details?: { count?: number } }) => e,
    );
    if (asked) {
      await run(
        "user.deactivate",
        { id: leaver.id, confirm: Number(asked.details?.count ?? 0) },
        staff(),
      );
    }
    expect((await view(admin, s)).run?.account).toBe(leaver.id);
    await done(admin, s, { forWhy: "They have left; the shift was worked" });
    expect((await runRow(s))?.state).toBe("done");
  });
});

// --- The operations' own guards -------------------------------------------------------------------------

describe("each checklist operation guards itself, whoever's tool calls it", () => {
  it("another shipped pack's open tool is refused (a person at the screen only); its person-only tool reaches only what the caller may", async () => {
    const duty = await dutyWith(await template([{ text: "Restock" }]));
    const person = await account(unique("Guarded Gu"));
    const member = await account(unique("Member Me"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
    const inputs: Record<(typeof RELAYED)[number], unknown> = {
      forRecord: { object: SHIFT, id: s },
      tick: { object: SHIFT, id: s, step: 0, state: "done" },
      complete: { object: SHIFT, id: s },
      runs: { from: date, to: date },
      correct: { run: "ckr_missing", text: "x" },
    };
    for (const name of RELAYED) {
      for (const who of [member, admin]) {
        expect([name, await rule(run(`x.checkrelay.${name}`, inputs[name], asUser(who)))]).toEqual([
          name,
          "human_only",
        ]);
      }
      // A person-only tool of another pack, called by a member who is not the shift's and does
      // not roster: the run is not theirs to read, tick or mark, nor everyone's to list.
      const error = await rule(run(`x.checkrelay.${name}Human`, inputs[name], asUser(member)));
      expect([name, error]).toEqual([name, expect.stringMatching(/not_found|rostering/)]);
    }
  });
});

// --- The review of PR #298 -----------------------------------------------------------------------------

describe("which checklist a duty carries is a rosterer's (the review of PR #298, item 1)", () => {
  it("a member, a team account and the shift's own person cannot change or clear it; a rosterer can; an AI's change is approved only by a rosterer", async () => {
    const first = await template([{ text: "One" }]);
    const second = await template([{ text: "Other" }]);
    const duty = await dutyWith(first);
    const member = await account(unique("Member Mb"));
    const team = await fixedRole(unique("Team Tm"), "rostering.team");
    const person = await account(unique("Person Ps"));
    await shiftOf(duty, -10 * MINUTE, person.id);
    for (const who of [member, team, person]) {
      for (const value of [null, second]) {
        const e = await refusal(
          run(
            "record.update",
            { object: DUTY, id: duty, values: { checklist: value } },
            asUser(who),
          ),
        );
        expect([who.name, JSON.stringify(e)]).toEqual([
          who.name,
          expect.stringMatching(/"rule":"rostering"|"code":"forbidden"/),
        ]);
      }
    }
    // The assistant asks; a member cannot approve it, a rosterer can.
    const asked = await refusal(
      run("record.update", { object: DUTY, id: duty, values: { checklist: second } }, asAi(admin)),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = (asked.details as { actionId: string }).actionId;
    await refusal(run("approval.approve", { actionIds: [actionId] }, asUser(member)));
    const rosterer = await account(unique("Rosterer Rs"));
    await run("user.setPermissions", { id: rosterer.id, permissions: [MANAGE] }, staff());
    await run("approval.approve", { actionIds: [actionId] }, asUser(rosterer));
    const stored = await env.DB.prepare("SELECT checklist FROM x_rostering_duty WHERE id = ?")
      .bind(duty)
      .first<{ checklist: string }>();
    expect(stored?.checklist).toBe(second);
    await run(
      "record.update",
      { object: DUTY, id: duty, values: { checklist: null } },
      asUser(rosterer),
    );
  });

  it("once a run's window has opened it keeps the checklist it opened with; before, it is remade", async () => {
    const first = await template([{ text: "First steps" }]);
    const second = await template([{ text: "Second steps" }]);
    const duty = await dutyWith(first);
    const person = await account(unique("Kept Kp"));
    // Ended 1 h 55 min ago: open, inside its grace, nothing ticked.
    const opened = await shiftOf(duty, -(2 * HOUR + 55 * MINUTE), person.id);
    const later = await shiftOf(duty, 6 * HOUR, person.id);
    await cron();
    const before = await runRow(opened);
    const laterBefore = await runRow(later);
    await run("record.update", { object: DUTY, id: duty, values: { checklist: second } }, staff());
    await cron();
    expect((await runRow(opened))?.id).toBe(before?.id);
    expect((await view(admin, opened)).run?.template.id).toBe(first);
    // The one not yet open is remade from the new checklist.
    const remade = await runRow(later);
    expect(remade?.id).not.toBe(laterBefore?.id);
    expect((await view(admin, later)).run?.template.id).toBe(second);
    // So clearing the checklist cannot make the opened one disappear: it is missed at its close.
    await run("record.update", { object: DUTY, id: duty, values: { checklist: null } }, staff());
    await cron(new Date(Date.now() + 6 * MINUTE));
    expect((await runRow(opened))?.state).toBe("missed");
  });
});

describe("cancelling or binning a shift that has started is a rosterer's (item 1)", () => {
  it("the shift's own person, a member and a team account are refused; a rosterer's cancel closes the run as cancelled with who", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const person = await account(unique("Own Ow"));
    const member = await account(unique("Member Mm"));
    const team = await fixedRole(unique("Team Tt"), "rostering.team");
    const s = await shiftOf(duty, -(2 * HOUR + 55 * MINUTE), person.id);
    await cron();
    for (const who of [person, member, team]) {
      const cancel = await refusal(
        run("record.update", { object: SHIFT, id: s, values: { state: "cancelled" } }, asUser(who)),
      );
      expect(JSON.stringify(cancel)).toMatch(/"rule":"rostering"|"code":"forbidden"/);
      const bin = await refusal(run("record.delete", { object: SHIFT, id: s }, asUser(who)));
      expect(JSON.stringify(bin)).toMatch(/"rule":"rostering"|"code":"forbidden"/);
    }
    // An assistant never cancels it, even for someone who rosters.
    expect(
      await rule(
        run("record.update", { object: SHIFT, id: s, values: { state: "cancelled" } }, asAi(admin)),
      ),
    ).toBe("person_applies");
    const rosterer = await account(unique("Rosterer Rc"));
    await run("user.setPermissions", { id: rosterer.id, permissions: [MANAGE] }, staff());
    await run(
      "record.update",
      { object: SHIFT, id: s, values: { state: "cancelled" } },
      asUser(rosterer),
    );
    await cron(new Date(Date.now() + 6 * MINUTE));
    const r = await runRow(s);
    expect(r?.state).toBe("cancelled");
    expect((r as { closed_by?: string } | null)?.closed_by).toBe(rosterer.id);
  });

  it("a run whose shift ended after it opened by someone who does not roster closes as missed, and the rosterers are told", async () => {
    const name = unique("Ended ");
    const duty = await dutyWith(await template([{ text: "One" }], name));
    const person = await account(unique("Ender En"));
    const s = await shiftOf(duty, -(2 * HOUR + 55 * MINUTE), person.id);
    await cron();
    // Only a path that does not ask who rosters leaves this mark (a product with no rosterers'
    // declaration): the host's rule at the close is what is checked here.
    await env.DB.prepare(
      "UPDATE core_checklist_run SET ended_at = ?, ended_by = NULL WHERE object_type = ? AND record_id = ?",
    )
      .bind(new Date().toISOString(), SHIFT, s)
      .run();
    await env.DB.prepare("UPDATE x_rostering_shift SET deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), s)
      .run();
    await cron(new Date(Date.now() + 6 * MINUTE));
    expect((await runRow(s))?.state).toBe("missed");
    const told = await env.DB.prepare("SELECT body FROM core_notifications WHERE title LIKE ?")
      .bind(`%${name}%`)
      .all<{ body: string }>();
    expect(told.results.length).toBeGreaterThan(0);
  });
});

describe("a closed run's readers (item 2)", () => {
  it("the shift reassigned after the close: the new person reads nothing of it, the person it closed for still does", async () => {
    const duty = await dutyWith(await template([{ text: "Count", note: true }]));
    const first = await account(unique("Closed Cf"));
    const second = await account(unique("After Af"));
    const s = await shiftOf(duty, -30 * MINUTE, first.id);
    await tick(first, s, 0, { note: "A private count" });
    await done(first, s);
    await run("x.rostering.assign", { object: SHIFT, id: s, account: second.id }, staff());
    expect(await rule(view(second, s))).toBe("not_found");
    expect((await view(first, s)).run?.steps[0]?.tick?.note).toBe("A private count");
  });
});

describe("reassigned mid-run, and every tick kept (items 3 and 4)", () => {
  it("the new person sees what is done and by whom, never the earlier person's words, and cannot change their tick; a rosterer can, and the earlier tick stays", async () => {
    const duty = await dutyWith(await template([{ text: "Count", note: true }, { text: "Two" }]));
    const first = await account(unique("Earlier Ea"));
    const second = await account(unique("Later La"));
    const s = await shiftOf(duty, -30 * MINUTE, first.id);
    await tick(first, s, 0, { note: "Earlier words" });
    await run("x.rostering.assign", { object: SHIFT, id: s, account: second.id }, staff());
    const seen = await view(second, s);
    expect(seen.run?.steps[0]?.tick).toMatchObject({ by: first.id, note: null, withheld: true });
    expect(JSON.stringify(seen)).not.toContain("Earlier words");
    expect(await rule(tick(second, s, 0, { note: "Mine now" }))).toBe("checklist_not_your_tick");
    expect(await rule(tick(second, s, 0, { state: "clear" }))).toBe("checklist_not_your_tick");
    // A rosterer's overwrite is a new tick; the earlier one stays, for its author and rosterers.
    await tick(admin, s, 0, { state: "not_done", why: "Short", forWhy: "Checked on the day" });
    const asRosterer = await view(admin, s);
    expect(asRosterer.run?.steps[0]?.tick).toMatchObject({ by: admin.id, onBehalf: true });
    expect(asRosterer.run?.steps[0]?.history).toEqual([
      expect.objectContaining({ note: "Earlier words" }),
    ]);
    const asFirst = await view(first, s);
    expect(asFirst.run?.steps[0]?.history[0]?.note).toBe("Earlier words");
    // A clear is a tick too.
    await tick(admin, s, 0, { state: "clear", forWhy: "Do it again" });
    const rows = await env.DB.prepare(
      "SELECT t.state FROM core_checklist_tick t JOIN core_checklist_run r ON r.id = t.run_id WHERE r.record_id = ? AND t.position = 0 ORDER BY t.ticked_at, t.id",
    )
      .bind(s)
      .all<{ state: string }>();
    expect(rows.results.map((r) => r.state)).toEqual(["done", "not_done", "cleared"]);
    expect((await view(admin, s)).run?.steps[0]?.tick).toBeNull();
  });

  it("tick rows are insert-only on an open run too, by every statement shape", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const person = await account(unique("Insert In"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    await tick(person, s, 0);
    const t = await env.DB.prepare(
      "SELECT t.id, t.run_id FROM core_checklist_tick t JOIN core_checklist_run r ON r.id = t.run_id WHERE r.record_id = ?",
    )
      .bind(s)
      .first<{ id: string; run_id: string }>();
    const now = new Date().toISOString();
    for (const statement of [
      ["UPDATE core_checklist_tick SET note = 'x' WHERE id = ?", [t?.id]],
      ["UPDATE OR REPLACE core_checklist_tick SET position = 0 WHERE id = ?", [t?.id]],
      ["DELETE FROM core_checklist_tick WHERE id = ?", [t?.id]],
      [
        "INSERT OR REPLACE INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'cleared', 'x', 'x', 0, ?)",
        [t?.id, t?.run_id, now],
      ],
      [
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'cleared', 'x', 'x', 0, ?) ON CONFLICT (id) DO UPDATE SET state = 'cleared'",
        [t?.id, t?.run_id, now],
      ],
    ] as const) {
      const error = await env.DB.prepare(statement[0])
        .bind(...statement[1])
        .run()
        .then(
          () => null,
          (e: Error) => e.message,
        );
      expect([statement[0], error]).toEqual([
        statement[0],
        expect.stringMatching(/core_checklist_fixed/),
      ]);
    }
    // Done needs every required step's latest tick: the database refuses it otherwise.
    const second = await shiftOf(duty, -9 * MINUTE, (await account(unique("Db Db"))).id);
    await cron();
    const r = await runRow(second);
    const incomplete = await env.DB.prepare(
      "UPDATE core_checklist_run SET state = 'done', closed_at = ? WHERE id = ?",
    )
      .bind(now, r?.id)
      .run()
      .then(
        () => null,
        (e: Error) => e.message,
      );
    expect(incomplete).toMatch(/core_checklist_incomplete/);
  });
});

describe("an AI never lists a checklist's audit rows (item 5)", () => {
  it("audit.list for an admin's assistant leaves out the ticks, for a person it lists them without how it went", async () => {
    const duty = await dutyWith(await template([{ text: "One" }, { text: "Two" }]));
    const person = await account(unique("Audited Au"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    await tick(person, s, 0, { state: "not_done", why: "A private why" });
    for (const operation of ["checklist.tick", "x.rostering.tick"]) {
      const ai = await run<{ items: unknown[] }>("audit.list", { operation }, asAi(admin));
      expect([operation, ai.items.length]).toEqual([operation, 0]);
      const human = await run<{ items: unknown[] }>("audit.list", { operation }, staff());
      expect(human.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(human.items)).not.toContain("not_done");
      expect(JSON.stringify(human.items)).not.toContain("A private why");
    }
  });
});

describe("the cron's quiet minute and its floor (items 6 and 7)", () => {
  it("a duty naming an inactive checklist gives no work: a quiet minute writes nothing", async () => {
    const t = await template([{ text: "One" }]);
    const duty = await dutyWith(t);
    await run(
      "checklist.save",
      { id: t, name: "Retired one", active: false, steps: [{ text: "One" }] },
      staff(),
    );
    const trashedDuty = await dutyWith(await template([{ text: "Two" }]));
    const person = await account(unique("Quiet Qu"));
    const s = await shiftOf(duty, 40 * DAY, person.id);
    const t2 = await shiftOf(trashedDuty, 40 * DAY + 2 * HOUR, person.id);
    await run("record.delete", { object: DUTY, id: trashedDuty }, staff());
    const at = new Date(Date.now() + 40 * DAY - HOUR);
    // Settle anything else due then.
    for (let i = 0; i < 5; i++) await runChecklistDue(db, { clock: () => at });
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_audit WHERE operation = 'checklist.due'",
        ).first<{
          n: number;
        }>()
      )?.n;
    const before = await count();
    for (let i = 0; i < 3; i++) await runChecklistDue(db, { clock: () => at });
    expect(await count()).toBe(before);
    expect(await runRow(s)).toBeNull();
    expect(await runRow(t2)).toBeNull();
  });

  it("runs as the host under an approval floor on automation writes, never queued", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const s = await shiftOf(duty, 45 * DAY, (await account(unique("Floor Fl"))).id);
    const floor = { automation: { write: "review" as const } };
    const pending = async () =>
      (await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{ n: number }>())
        ?.n ?? 0;
    const before = await pending();
    await runChecklistDue(db, { floor, clock: () => new Date(Date.now() + 45 * DAY - HOUR) });
    expect(await pending()).toBe(before);
    expect((await runRow(s))?.state).toBe("open");
  });
});

describe("the largest checklist (item 8) and required steps only (item 9)", () => {
  it("200 runs of a 50-step checklist of the longest steps are made, in statements under the size limit", async () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      text: `${i} ${"x".repeat(296)}`.slice(0, 300),
      required: i % 2 === 0,
    }));
    const duty = await dutyWith(await template(steps));
    const people: ActingUser[] = [];
    for (let i = 0; i < 200; i++) people.push(await account(`Big ${i} ${unique("")}`));
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      ids.push(await shiftOf(duty, 50 * DAY + i * 2 * MINUTE, people[i]?.id ?? null, 0.03));
    }
    const at = new Date(Date.now() + 50 * DAY - HOUR);
    await runChecklistDue(db, { clock: () => at });
    const made = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_checklist_run WHERE record_id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(ids))
      .first<{ n: number }>();
    expect(made?.n).toBe(200);
    // Missed: only the required steps nobody ticked.
    const late = new Date(Date.now() + 50 * DAY + 8 * HOUR + 3 * HOUR);
    await runChecklistDue(db, { clock: () => late });
    const r = await runRow(ids[0] as string);
    expect(r?.state).toBe("missed");
    expect(JSON.parse(r?.missed_steps ?? "[]")).toEqual(
      Array.from({ length: 25 }, (_, i) => i * 2),
    );
  }, 300_000);
});

let statementsOfFullHistory = 0;

// --- The second review of PR #298 -------------------------------------------------------------------

describe("what a shift's checklist hangs on is a rosterer's (second review, items 1 and 2)", () => {
  it("a member or the shift's own person cannot move a shift to a duty with no checklist, or off one; a rosterer can; an AI's change waits for a rosterer", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const bare = await dutyWith(null);
    const bare2 = await dutyWith(null);
    const person = await account(unique("Mover Mv"));
    const member = await account(unique("Member Mn"));
    const s = await shiftOf(duty, 3 * HOUR, person.id);
    await cron();
    const before = await runRow(s);
    for (const who of [person, member]) {
      expect(
        await rule(
          run("record.update", { object: SHIFT, id: s, values: { duty: bare } }, asUser(who)),
        ),
      ).toBe("rostering");
    }
    await cron();
    expect((await runRow(s))?.id).toBe(before?.id);
    // Between duties with no checklist, nothing hangs on it: whoever may write the shift.
    const free = await shiftOf(bare, 4 * HOUR, person.id);
    await run(
      "record.update",
      { object: SHIFT, id: free, values: { duty: bare2 } },
      asUser(member),
    );
    // An assistant's change of it is approved only by someone who rosters.
    const asked = await refusal(
      run("record.update", { object: SHIFT, id: s, values: { duty: bare } }, asAi(admin)),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = (asked.details as { actionId: string }).actionId;
    await refusal(run("approval.approve", { actionIds: [actionId] }, asUser(member)));
    await run("approval.approve", { actionIds: [actionId] }, staff());
    expect((await runRow(s))?.id).toBe(before?.id); // Removed by the next minute, not now.
  });

  it("a member cannot put a duty that carries a checklist in the Trash, or bring it back; a rosterer can, and its shifts then get no run", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const person = await account(unique("Binner Bn"));
    const s = await shiftOf(duty, 30 * HOUR, person.id);
    expect(await rule(run("record.delete", { object: DUTY, id: duty }, asUser(person)))).toBe(
      "rostering",
    );
    // A duty with no checklist is anyone's who may write duties.
    const bare = await dutyWith(null);
    await run("record.delete", { object: DUTY, id: bare }, asUser(person));
    await run("record.delete", { object: DUTY, id: duty }, staff());
    expect(await rule(run("record.restore", { object: DUTY, id: duty }, asUser(person)))).toBe(
      "rostering",
    );
    await cron(new Date(Date.now() + 8 * HOUR));
    expect(await runRow(s)).toBeNull();
    // An assistant's restore of it waits for someone who rosters.
    expect(await rule(run("record.restore", { object: DUTY, id: duty }, asAi(admin)))).toMatch(
      /person_applies|pending_approval/,
    );
  });
});

describe("a cleared step is anyone's who may tick the run (second review, item 3)", () => {
  it("the new person on a shift ticks a step the earlier person cleared, and a person redoes a step a rosterer cleared for them", async () => {
    const duty = await dutyWith(await template([{ text: "One" }, { text: "Two" }]));
    const first = await account(unique("Clear Ca"));
    const second = await account(unique("Clear Cb"));
    const s = await shiftOf(duty, -10 * MINUTE, first.id);
    await tick(first, s, 0);
    await tick(first, s, 0, { state: "clear" });
    await run("x.rostering.assign", { object: SHIFT, id: s, account: second.id }, staff());
    await tick(second, s, 0);
    await tick(second, s, 1);
    await done(second, s);
    expect((await runRow(s))?.state).toBe("done");
    const ownerUser = await account(unique("Clear Cc"));
    const other = await shiftOf(duty, -9 * MINUTE, ownerUser.id);
    await tick(ownerUser, other, 0);
    await tick(admin, other, 0, { state: "clear", forWhy: "Do it again" });
    await tick(ownerUser, other, 0);
    expect((await view(ownerUser, other)).run?.steps[0]?.tick?.by).toBe(ownerUser.id);
  });
});

describe("corrections are read by the run's own person and rosterers (second review, item 4)", () => {
  it("someone who once ticked a run that closed for another reads their own ticks, never its corrections", async () => {
    const duty = await dutyWith(await template([{ text: "One", note: true }, { text: "Two" }]));
    const first = await account(unique("Corr Ca"));
    const second = await account(unique("Corr Cb"));
    const s = await shiftOf(duty, -10 * MINUTE, first.id);
    await tick(first, s, 0, { note: "First words" });
    await run("x.rostering.assign", { object: SHIFT, id: s, account: second.id }, staff());
    await tick(second, s, 1);
    await done(second, s);
    const r = await runRow(s);
    await run("x.rostering.checklistCorrect", { run: r?.id, text: "About the second" }, staff());
    const asFirst = await view(first, s);
    expect(asFirst.run?.corrections).toEqual([]);
    expect(asFirst.run?.steps[0]?.tick?.note).toBe("First words");
    expect((await view(second, s)).run?.corrections.map((c) => c.text)).toEqual([
      "About the second",
    ]);
  });
});

describe("a run keeps its checklist once open, and the minute stays quiet (second review, item 5)", () => {
  it("an opened run whose duty now names another checklist is neither removed nor worked on every minute", async () => {
    const first = await template([{ text: "Opened with" }]);
    const second = await template([{ text: "Changed to" }]);
    const duty = await dutyWith(first);
    const person = await account(unique("Open Op"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    await cron();
    const made = await runRow(s);
    await run("record.update", { object: DUTY, id: duty, values: { checklist: second } }, staff());
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_audit WHERE operation = 'checklist.due'",
        ).first<{ n: number }>()
      )?.n;
    // Settle anything else, then two quiet minutes.
    for (let i = 0; i < 3; i++) await cron();
    const before = await count();
    await cron();
    await cron();
    expect(await count()).toBe(before);
    expect((await runRow(s))?.id).toBe(made?.id);
    expect((await view(admin, s)).run?.template.id).toBe(first);
  });
});

describe("a step's ticks are capped (second review, item 6)", () => {
  it("at most 50 ticks of one step, refused beyond; a read shows the latest 20 earlier ones and says it left some out", async () => {
    const duty = await dutyWith(await template([{ text: "One" }]));
    const person = await account(unique("Cap Cp"));
    const s = await shiftOf(duty, -10 * MINUTE, person.id);
    for (let i = 0; i < 50; i++) {
      await tick(person, s, 0, i % 2 ? { state: "clear" } : {});
    }
    expect(await rule(tick(person, s, 0, { state: "clear" }))).toBe("checklist_too_many_ticks");
    const step = (await view(person, s)).run?.steps[0] as unknown as {
      history: unknown[];
      historyTruncated: boolean;
    };
    expect(step.history).toHaveLength(20);
    expect(step.historyTruncated).toBe(true);
    // The database holds it too, for every writer.
    const runId = (await runRow(s))?.id;
    const error = await env.DB.prepare(
      "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES ('ckt_over', ?, 0, 'done', ?, ?, 0, ?)",
    )
      .bind(runId, person.id, person.id, new Date().toISOString())
      .run()
      .then(
        () => null,
        (e: Error) => e.message,
      );
    expect(error).toMatch(/core_checklist_too_many_ticks/);
    const counted = await queriesOf(() => view(person, s));
    expect(counted.outcome).toBe("ok");
    expect(counted.queries).toBeLessThan(CEILING);
    statementsOfFullHistory = counted.queries;
    expect(statementsOfFullHistory).toBeGreaterThan(0);
  });
});

// --- What one call reads -----------------------------------------------------------------------------

/** How many statements `call` prepares against D1 (each query is one). */
async function queriesOf(
  call: () => Promise<unknown>,
): Promise<{ queries: number; outcome: string }> {
  const d1 = env.DB as unknown as { prepare: (...a: unknown[]) => unknown };
  const prepare = d1.prepare.bind(d1);
  let queries = 0;
  d1.prepare = (...a: unknown[]) => {
    queries++;
    return prepare(...a);
  };
  try {
    const outcome = await call().then(
      () => "ok",
      (e: { code?: string }) => String(e.code),
    );
    return { queries, outcome };
  } finally {
    d1.prepare = prepare;
  }
}

/** Well under D1's 1,000 a call, for the largest input each takes. */
const CEILING = 250;
const counted: Record<string, number> = {};

describe("what one call reads, at the largest input (ADR 0629)", () => {
  it("the cron, the week with checklists, a run of 50 steps and the rosterers' list each stay well under D1's limit", async () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      text: `Step ${i + 1}`,
      note: i % 10 === 0,
    }));
    const big = await template(steps);
    const duties = [await dutyWith(big), await dutyWith(await template([{ text: "One" }]))];
    // 400 shifts with checklists tomorrow and the day after, two duties, 200 people.
    const people: ActingUser[] = [];
    for (let i = 0; i < 200; i++) people.push(await account(`Load ${i} ${unique("")}`));
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) {
      ids.push(
        await shiftOf(
          duties[i % 2] as string,
          20 * DAY + (i % 2) * 4 * HOUR + Math.floor(i / 200) * DAY,
          people[i % 200]?.id ?? null,
        ),
      );
    }
    const at = new Date(Date.now() + 20 * DAY - 2 * HOUR);
    const made = await queriesOf(() => runChecklistDue(db, { clock: () => at }));
    expect(made.outcome).toBe("ok");
    expect(made.queries).toBeLessThan(CEILING);
    counted.cronMake = made.queries;
    // Two minutes' work made them all (at most 200 a minute per object).
    await runChecklistDue(db, { clock: () => at });
    await runChecklistDue(db, { clock: () => at });
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(Date.now() + 19 * DAY),
    );
    const to = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(Date.now() + 80 * DAY),
    );
    for (const [label, call] of [
      ["week", () => run("x.rostering.week", { from, to }, staff())],
      ["checklist", () => run("x.rostering.checklist", { object: SHIFT, id: ids[0] }, staff())],
      ["checklistRuns", () => run("x.rostering.checklistRuns", { from, to }, staff())],
      ["cron close", () => runChecklistDue(db, { clock: () => new Date(Date.now() + 23 * DAY) })],
    ] as const) {
      const c = await queriesOf(call);
      expect([label, c.outcome]).toEqual([label, "ok"]);
      expect([label, c.queries < CEILING]).toEqual([label, true]);
      counted[label] = c.queries;
    }
    expect(Object.keys(counted).sort()).toEqual([
      "checklist",
      "checklistRuns",
      "cron close",
      "cronMake",
      "week",
    ]);
  }, 300_000);
});
