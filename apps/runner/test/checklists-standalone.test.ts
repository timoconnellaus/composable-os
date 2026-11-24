// Checklists on their own, without a roster (ADR 0651; a follow-on to stage 45 step 4b, ADR 0650),
// on the shipped Daily checklists pack in the real host and sandbox. A checklist given a standing
// schedule is due on its days in the business's time zone; each due day gets one run, made by the
// minute cron (or the first tick); anyone who may do it ticks it, the run keeping who ticked each
// step and when; whoever ticks the last step finishes it; a finished run never changes, and only
// someone allowed ticks, for every writer (the database's triggers); a run not finished by the end
// of its day is missed and the people who manage checklists are told; they see how each day went
// and may tick for someone, with why; the assistant's template waits for a person and an AI never
// ticks. First without Rostering; then with it installed, a duty's checklist is as it was and the
// pack roles reach the day's checklists (a cleaner's account). Last, what one call reads.
//
// Clocks: a tool's own calls read the real clock, so the day that is ticked is today in the
// business's zone; the minute cron is run with an explicit clock.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  newId,
  refreshSchemaRegistry,
  runChecklistDue,
  toOperationError,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, queriesOf, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  dailychecks: packFiles("dailychecks"),
  rostering: packFiles("rostering"),
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "dailychecks", version: "0.1.0" },
    { id: "rostering", version: "0.1.0" },
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
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

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

type Who =
  | { kind: "staff" }
  | { kind: "role"; role: string }
  | { kind: "grant"; permission: string };
/** A checklist done on its own, due every day (or on `days`), by `who`. */
async function scheduled(
  steps: { text: string; required?: boolean; note?: boolean }[],
  who: Who = { kind: "staff" },
  extra: { dueBy?: string | null; days?: number[]; name?: string } = {},
): Promise<string> {
  return (
    await run<{ id: string }>(
      "checklist.save",
      {
        name: extra.name ?? unique("Opening up "),
        steps,
        schedule: { days: extra.days ?? EVERY_DAY, dueBy: extra.dueBy ?? null, who },
      },
      staff(),
    )
  ).id;
}
const today = (at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(at);
const cron = (at = new Date()) => runChecklistDue(db, { clock: () => at });

type Item = {
  template: { id: string; name: string };
  date: string;
  state: string;
  dueBy: string | null;
  late: boolean;
  mayDo: boolean;
  canTick: boolean;
  preview: { text: string }[] | null;
  run: {
    id: string;
    state: string;
    account: string | null;
    closedBy: string | null;
    closedWhy: string | null;
    steps: {
      text: string;
      missed: boolean;
      tick: {
        by: string;
        for: string;
        at: string;
        onBehalf: boolean;
        label: string;
        note: string | null;
        withheld: boolean;
      } | null;
    }[];
  } | null;
};
const todayOf = async (user: ActingUser) =>
  run<{ date: string; items: Item[]; youManage: boolean }>("x.dailychecks.today", {}, asUser(user));
const itemOf = async (user: ActingUser, template: string) =>
  (await todayOf(user)).items.find((i) => i.template.id === template);
const dayOf = (user: ActingUser, template: string, date = today()) =>
  run<{ item: Item; doers: { id: string; name: string }[] | null }>(
    "x.dailychecks.day",
    { template, date },
    asUser(user),
  );
const tick = (
  user: ActingUser,
  template: string,
  step: number,
  extra: Record<string, unknown> = {},
) =>
  run<{ finished: boolean; run: string }>(
    "x.dailychecks.tick",
    { template, date: today(), step, state: "done", ...extra },
    asUser(user),
  );
const runRow = (template: string, date = today()) =>
  env.DB.prepare(
    "SELECT * FROM core_checklist_run WHERE object_type = 'checklist.day' AND record_id = ?",
  )
    .bind(`${template}:${date}`)
    .first<{
      id: string;
      state: string;
      account_id: string | null;
      closed_by: string | null;
      closed_why: string | null;
      missed_steps: string | null;
      doers_kind: string;
      doers_value: string | null;
      due_at: number | null;
      opens: number;
      closes: number;
    }>();
const dbError = (statement: string, ...binds: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    );

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  await run("extension.install", { id: "dailychecks", shipped: true }, staff());
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
}, 120_000);

// --- The schedule --------------------------------------------------------------------------------

describe("a checklist's standing schedule (Settings → Checklists)", () => {
  it("is written with the template by checklists:write, read back by every staff account, and checked", async () => {
    const id = await scheduled(
      [{ text: "Lights on" }],
      { kind: "role", role: "member" },
      {
        days: [5, 1, 3],
        dueBy: "09:00",
      },
    );
    const got = await run<{ schedule: unknown }>("checklist.get", { id }, staff());
    expect(got.schedule).toEqual({
      days: [1, 3, 5],
      dueBy: "09:00",
      who: { kind: "role", value: "member" },
    });
    const member = await account(unique("Reader Re"));
    const listed = await run<{ items: { id: string; schedule: unknown }[] }>(
      "checklist.list",
      {},
      asUser(member),
    );
    expect(listed.items.find((i) => i.id === id)?.schedule).toEqual(got.schedule);
    // A role that is not one, a grant nobody can be given: refused.
    for (const who of [
      { kind: "role", role: "nobody.special" },
      { kind: "grant", permission: "users:manage" },
    ]) {
      expect(
        await rule(
          run(
            "checklist.save",
            { name: "Bad", steps: [{ text: "x" }], schedule: { days: [1], who } },
            staff(),
          ),
        ),
      ).toBe("checklist_who");
    }
    // A change without `schedule` keeps it; null takes it away.
    await run("checklist.save", { id, name: "Renamed", steps: [{ text: "Lights on" }] }, staff());
    expect((await run<{ schedule: unknown }>("checklist.get", { id }, staff())).schedule).toEqual(
      got.schedule,
    );
    await run(
      "checklist.save",
      { id, name: "Renamed", steps: [{ text: "Lights on" }], schedule: null },
      staff(),
    );
    expect(
      (await run<{ schedule: unknown }>("checklist.get", { id }, staff())).schedule,
    ).toBeNull();
    // The choices the form offers name roles and grants, never an account.
    const choices = await run<{ roles: { role: string }[]; grants: { permission: string }[] }>(
      "checklist.whoChoices",
      {},
      staff(),
    );
    expect(choices.roles.map((r) => r.role)).toEqual(expect.arrayContaining(["admin", "member"]));
    expect(choices.grants.map((g) => g.permission)).toContain("checklists:write");
    // They are the form's, for those who write checklists: the permissions an admin can grant are
    // otherwise an admin's to read (user.grantablePermissions), and never an assistant's.
    const viewer = await account(unique("Viewer Vi"), "viewer");
    for (const ctx of [asUser(member), asUser(viewer), asAi(admin)]) {
      expect((await refusal(run("checklist.whoChoices", {}, ctx))).code).toBe("forbidden");
    }
    await run("user.setPermissions", { id: member.id, permissions: ["checklists:write"] }, staff());
    expect(
      (await run<{ grants: unknown[] }>("checklist.whoChoices", {}, asUser(member))).grants.length,
    ).toBeGreaterThan(0);
  });

  it("an assistant's scheduled checklist is not used until a person who may write checklists approves it", async () => {
    const name = unique("Drafted opening ");
    const queued = await refusal(
      run(
        "checklist.save",
        {
          name,
          steps: [{ text: "Unlock" }],
          schedule: { days: EVERY_DAY, who: { kind: "staff" } },
        },
        asAi(admin),
      ),
    );
    expect(queued.code).toBe("pending_approval");
    await cron();
    const member = await account(unique("Waiting Wa"));
    expect((await todayOf(member)).items.map((i) => i.template.name)).not.toContain(name);
    await run(
      "approval.approve",
      { actionIds: [String((queued.details as { actionId?: string }).actionId)] },
      staff(),
    );
    await cron();
    expect((await todayOf(member)).items.map((i) => i.template.name)).toContain(name);
  });
});

// --- One run a day, ticked by whoever may do it ----------------------------------------------------

describe("each due day gets one run that anyone who may do it ticks", () => {
  it("the cron makes today's run as the template is; anyone ticks; the last tick finishes it, by whoever made it", async () => {
    const id = await scheduled(
      [{ text: "Unlock the doors" }, { text: "Count the till" }],
      undefined,
      {
        dueBy: "23:59",
      },
    );
    const notToday = await scheduled([{ text: "Not today" }], undefined, {
      // Tomorrow's weekday only.
      days: [(isoWeekdayToday() % 7) + 1],
    });
    await cron();
    const made = await runRow(id);
    expect(made).toMatchObject({ state: "open", account_id: null, doers_kind: "staff" });
    expect(made?.due_at).toBeGreaterThan(0);
    expect(await runRow(notToday)).toBeNull();
    // Changed now, today's run keeps the steps it was made with.
    await run(
      "checklist.save",
      { id, name: "Changed", steps: [{ text: "Something else" }] },
      staff(),
    );
    const first = await account(unique("Opener Op"));
    const second = await account(unique("Closer Cl"));
    const item = await itemOf(first, id);
    expect(item?.run?.steps.map((s) => s.text)).toEqual(["Unlock the doors", "Count the till"]);
    expect(item).toMatchObject({ state: "open", mayDo: true, canTick: true, dueBy: "23:59" });
    expect((await tick(first, id, 0)).finished).toBe(false);
    // Someone else ticked it: only whoever manages checklists changes their tick.
    expect(await rule(tick(second, id, 0, { state: "clear" }))).toBe("checklist_not_your_tick");
    const last = await tick(second, id, 1, { note: "Float is right" });
    expect(last.finished).toBe(true);
    const row = await runRow(id);
    expect(row).toMatchObject({ state: "done", closed_by: second.id, account_id: second.id });
    const v = await itemOf(first, id);
    expect(v?.run?.steps.map((s) => s.tick?.by)).toEqual([first.id, second.id]);
    expect(v?.run?.steps[1]?.tick?.at).toEqual(expect.any(String));
    // The other's words are theirs and the managers'.
    expect(v?.run?.steps[1]?.tick).toMatchObject({ note: null, withheld: true });
    expect((await itemOf(admin, id))?.run?.steps[1]?.tick?.note).toBe("Float is right");
    // Finished: it never changes, through the tools or any statement.
    expect(await rule(tick(first, id, 0, { state: "clear" }))).toBe("checklist_closed");
    for (const [statement, binds, error] of [
      [
        "UPDATE core_checklist_run SET state = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?",
        [row?.id],
        "core_checklist_closed",
      ],
      ["DELETE FROM core_checklist_run WHERE id = ?", [row?.id], "core_checklist_closed"],
      ["DELETE FROM core_checklist_tick WHERE run_id = ?", [row?.id], "core_checklist_fixed"],
      [
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES ('ckt_late', ?, 0, 'cleared', ?, ?, 0, ?)",
        [row?.id, first.id, first.id, new Date().toISOString()],
        "core_checklist_closed",
      ],
    ] as const) {
      expect(await dbError(statement, ...binds)).toMatch(error);
    }
    // One run a day, ever.
    expect(
      await dbError(
        "INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps, opens, closes, state, made_at, doers_kind) VALUES ('ckr_again', 'checklist.day', ?, ?, 1, 'x', '[{\"text\":\"x\",\"required\":true,\"note\":false}]', 0, 1, 'open', 'now', 'staff')",
        `${id}:${today()}`,
        id,
      ),
    ).toMatch(/core_checklist_fixed/);
  });

  it("the first tick makes the run when the cron has not yet; optional steps left, it is finished by hand once the required ones are", async () => {
    const id = await scheduled([
      { text: "Mop", required: true },
      { text: "Wipe the windows", required: false },
      { text: "Note the fridge", required: true, note: true },
    ]);
    const person = await account(unique("Cleaner Cl"));
    expect((await itemOf(person, id))?.preview?.map((p) => p.text)).toEqual([
      "Mop",
      "Wipe the windows",
      "Note the fridge",
    ]);
    await tick(person, id, 0);
    expect(await rule(tick(person, id, 2))).toBe("checklist_note_needed");
    expect(await rule(tick(person, id, 2, { state: "not_done" }))).toBe("checklist_why");
    expect((await tick(person, id, 2, { note: "4 degrees" })).finished).toBe(false);
    expect((await runRow(id))?.state).toBe("open");
    await run("x.dailychecks.done", { template: id, date: today() }, asUser(person));
    expect(await runRow(id)).toMatchObject({ state: "done", closed_by: person.id });
    // A day that is not today is not ticked.
    expect(
      await rule(
        run(
          "x.dailychecks.tick",
          { template: id, date: today(new Date(Date.now() + DAY)), step: 0, state: "done" },
          asUser(person),
        ),
      ),
    ).toBe("not_found");
  });
});

/** Today's ISO weekday in the business's zone (1 Monday … 7 Sunday). */
function isoWeekdayToday(): number {
  const [y, m, d] = today().split("-").map(Number);
  const day = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
  return day === 0 ? 7 : day;
}

// --- Who may do it ---------------------------------------------------------------------------------

describe("only someone allowed ticks, for every writer", () => {
  it("a checklist for a role or a grant is theirs alone; a viewer never ticks; the database refuses anyone else's tick", async () => {
    const forMembers = await scheduled([{ text: "Open the till" }], {
      kind: "role",
      role: "member",
    });
    const forGrant = await scheduled([{ text: "Check the safe" }], {
      kind: "grant",
      permission: "checklists:write",
    });
    const member = await account(unique("Member Me"));
    const viewer = await account(unique("Viewer Vi"), "viewer");
    const granted = await account(unique("Granted Gr"));
    await run(
      "user.setPermissions",
      { id: granted.id, permissions: ["checklists:write"] },
      staff(),
    );
    await cron();
    expect((await itemOf(member, forMembers))?.mayDo).toBe(true);
    expect(await itemOf(member, forGrant)).toBeUndefined();
    expect(await rule(dayOf(member, forGrant))).toBe("not_found");
    expect(await rule(tick(member, forGrant, 0))).toBe("not_found");
    // A viewer reads nothing to do and cannot tick (it may not write).
    expect((await refusal(tick(viewer, forMembers, 0))).code).toBe("forbidden");
    // Granted: theirs to do.
    expect((await itemOf(granted, forGrant))?.mayDo).toBe(true);
    await tick(granted, forGrant, 0);
    expect((await runRow(forGrant))?.state).toBe("done");
    // The database refuses a tick for someone who may not do it, whoever writes it.
    const open = await runRow(forMembers);
    expect(
      await dbError(
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'done', ?, ?, 0, ?)",
        newId("checklistTick"),
        open?.id,
        viewer.id,
        viewer.id,
        new Date().toISOString(),
      ),
    ).toMatch(/core_checklist_not_allowed/);
    // And one on someone's behalf by anyone who does not manage checklists.
    expect(
      await dbError(
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, on_behalf_why, ticked_at) VALUES (?, ?, 0, 'done', ?, ?, 1, 'covering', ?)",
        newId("checklistTick"),
        open?.id,
        member.id,
        (await account(unique("Other Ot"))).id,
        new Date().toISOString(),
      ),
    ).toMatch(/core_checklist_not_allowed/);
    // And a finish by anyone else. Its required step ticked and an optional one left, so the
    // refusal is this rule's and not migration 0815's (every required step ticked).
    const finishing = await scheduled(
      [{ text: "Count the float" }, { text: "Water the plants", required: false }],
      { kind: "role", role: "member" },
    );
    await tick(member, finishing, 0);
    const half = await runRow(finishing);
    const other = await account(unique("Other Ot"));
    const finish = (by: string, forWhom: string, why: string | null) =>
      dbError(
        "UPDATE core_checklist_run SET state = 'done', closed_at = ?, closed_by = ?, account_id = ?, closed_why = ? WHERE id = ?",
        new Date().toISOString(),
        by,
        forWhom,
        why,
        half?.id,
      );
    // A viewer, for themselves.
    expect(await finish(viewer.id, viewer.id, null)).toMatch(/core_checklist_not_allowed/);
    // An admin for themselves, on a checklist for members (they manage it but may not do it).
    expect(await finish(admin.id, admin.id, null)).toMatch(/core_checklist_not_allowed/);
    // A member who does not manage checklists, for another member, with why.
    expect(await finish(member.id, other.id, "covering")).toMatch(/core_checklist_not_allowed/);
    // Someone who may do it, for themselves: done.
    expect(await finish(member.id, member.id, null)).toBeNull();
    // The host answers this rule's refusal as one (a race: someone's role changed meanwhile).
    const mapped = toOperationError(new Error("D1_ERROR: core_checklist_not_allowed: SQLITE"));
    expect(mapped.code).toBe("forbidden");
    expect((mapped.details as { rule?: string }).rule).toBe("checklist_not_allowed");
    // A day run's who and when are fixed while it is open.
    expect(
      await dbError(
        "UPDATE core_checklist_run SET doers_kind = 'staff', doers_value = NULL WHERE id = ?",
        open?.id,
      ),
    ).toMatch(/core_checklist_fixed/);
  });

  it("the database holds when: a tick inside its day, missed only after it and by nobody", async () => {
    const id = await scheduled([{ text: "Lock the back door" }]);
    const person = await account(unique("Locker Lo"));
    await cron();
    const open = await runRow(id);
    const at = (s: number) => new Date(s * 1000).toISOString();
    const tickAt = (when: string) =>
      dbError(
        "INSERT INTO core_checklist_tick (id, run_id, position, state, ticked_by, ticked_for, on_behalf, ticked_at) VALUES (?, ?, 0, 'done', ?, ?, 0, ?)",
        newId("checklistTick"),
        open?.id,
        person.id,
        person.id,
        when,
      );
    expect(await tickAt(at(Number(open?.closes)))).toMatch(/core_checklist_window/);
    expect(await tickAt(at(Number(open?.opens) - 1))).toMatch(/core_checklist_window/);
    const miss = (when: string, closer: string | null) =>
      dbError(
        "UPDATE core_checklist_run SET state = 'missed', closed_at = ?, closed_by = ? WHERE id = ?",
        when,
        closer,
        open?.id,
      );
    // Missed before its day ends, or by someone: refused, and the host says so as a rule.
    expect(await miss(new Date().toISOString(), null)).toMatch(/core_checklist_window/);
    expect(await miss(at(Number(open?.closes)), person.id)).toMatch(/core_checklist_window/);
    expect(toOperationError(new Error("D1_ERROR: core_checklist_window")).code).toBe("conflict");
    expect((await runRow(id))?.state).toBe("open");
    // Once its day has ended, by nobody: the minute cron's close.
    await cron(new Date((Number(open?.closes) + 1) * 1000));
    expect((await runRow(id))?.state).toBe("missed");
  });

  it("an AI never ticks or reads how a day went", async () => {
    const id = await scheduled([{ text: "Lights off" }]);
    const member = await account(unique("Asker As"));
    expect((await refusal(run("x.dailychecks.today", {}, asAi(member)))).code).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "x.dailychecks.tick",
            { template: id, date: today(), step: 0, state: "done" },
            asAi(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (await refusal(run("x.dailychecks.history", { from: today(), to: today() }, asAi(admin))))
        .code,
    ).toBe("forbidden");
    // The host operations themselves are a pack tool's only.
    expect((await refusal(run("checklist.today", {}, asUser(member)))).code).toMatch(
      /unknown_operation|forbidden/,
    );
  });
});

// --- Those who manage checklists ---------------------------------------------------------------------

describe("those who manage checklists", () => {
  it("tick for someone who may do it, with why, kept as ticked by them for that person", async () => {
    const id = await scheduled([{ text: "Restock towels" }, { text: "Empty the bins" }], {
      kind: "role",
      role: "member",
    });
    const person = await account(unique("Absent Ab"));
    // The admin manages checklists but is not a member: they tick only for someone.
    expect((await itemOf(admin, id))?.mayDo).toBe(false);
    expect(await rule(tick(admin, id, 0))).toBe("checklist_for_whom");
    expect(await rule(tick(admin, id, 0, { for: person.id }))).toBe("checklist_for_why");
    const doers = (await dayOf(admin, id)).doers?.map((d) => d.id);
    expect(doers).toContain(person.id);
    expect(doers).not.toContain(admin.id);
    await tick(admin, id, 0, { for: person.id, forWhy: "They opened, phone flat" });
    const t = (await itemOf(admin, id))?.run?.steps[0]?.tick;
    expect(t).toMatchObject({ by: admin.id, for: person.id, onBehalf: true });
    expect(t?.label).toMatch(/^Ticked by .+ for .+$/);
    // Someone who does not manage checklists ticks for nobody else.
    const member = await account(unique("Member Mb"));
    expect(await rule(tick(member, id, 1, { for: person.id, forWhy: "x" }))).toBe(
      "checklist_for_someone",
    );
    // Nor for someone who may not do it.
    const viewer = await account(unique("Viewer Vw"), "viewer");
    expect(await rule(tick(admin, id, 1, { for: viewer.id, forWhy: "x" }))).toBe(
      "checklist_not_theirs",
    );
    // The last tick for them finishes it: by the admin, for them, with why.
    await tick(admin, id, 1, { for: person.id, forWhy: "They opened, phone flat" });
    expect(await runRow(id)).toMatchObject({
      state: "done",
      closed_by: admin.id,
      account_id: person.id,
      closed_why: "They opened, phone flat",
    });
  });

  it("a day not finished by its end is missed, never changes after, and they are told; they see how each day went", async () => {
    const name = unique("Close-down ");
    const id = await scheduled([{ text: "Lock up" }, { text: "Alarm on" }], undefined, { name });
    const person = await account(unique("Late La"));
    await tick(person, id, 0);
    const open = await runRow(id);
    // Before the day ends, nothing is closed.
    await cron(new Date((Number(open?.closes) - 60) * 1000));
    expect((await runRow(id))?.state).toBe("open");
    await cron(new Date((Number(open?.closes) + 1) * 1000));
    const missed = await runRow(id);
    expect(missed?.state).toBe("missed");
    expect(JSON.parse(missed?.missed_steps ?? "[]")).toEqual([1]);
    expect(
      await dbError("UPDATE core_checklist_run SET state = 'done' WHERE id = ?", missed?.id),
    ).toMatch(/core_checklist_closed/);
    const told = await env.DB.prepare(
      "SELECT user_id, body, human_only FROM core_notifications WHERE body LIKE ?",
    )
      .bind(`%${name}%`)
      .all<{ user_id: string; body: string; human_only: number }>();
    expect(told.results.map((n) => n.user_id)).toContain(admin.id);
    // One notice a minute names every day missed in it: this one's line names its step not done.
    const line = (n: { body: string }) => n.body.split("\n").find((l) => l.includes(name)) ?? "";
    expect(
      told.results.every((n) => line(n).includes("Alarm on") && !line(n).includes("Lock up")),
    ).toBe(true);
    expect(told.results.every((n) => n.human_only === 1)).toBe(true);
    // How each day went: the managers'.
    const history = await run<{
      days: { run: string; state: string; missed: string[]; finishedBy: string | null }[];
    }>("x.dailychecks.history", { from: today(), to: today() }, staff());
    expect(history.days.find((d) => d.run === missed?.id)).toMatchObject({
      state: "missed",
      missed: ["Alarm on"],
    });
    // Its day, read by them afterwards; by anyone else it is not there (a member sees today's
    // only, and only what they may do).
    expect((await dayOf(admin, id)).item.state).toBe("missed");
    const member = await account(unique("Nosy No"));
    expect(
      (await refusal(run("x.dailychecks.history", { from: today(), to: today() }, asUser(member))))
        .code,
    ).toBe("forbidden");
    // Finished with every step ticked not done (each with why) is done, and the history says how
    // many were not done.
    const notDone = await scheduled([{ text: "Bins out" }, { text: "Hose the yard" }]);
    for (const step of [0, 1]) {
      await tick(person, notDone, step, { state: "not_done", why: "Rain" });
    }
    expect(
      (
        await run<{ days: { run: string; state: string; notDone: number }[] }>(
          "x.dailychecks.history",
          { from: today(), to: today(), template: notDone },
          staff(),
        )
      ).days,
    ).toMatchObject([{ state: "done", notDone: 2 }]);
    // Granted checklists:write, a member manages checklists.
    await run("user.setPermissions", { id: member.id, permissions: ["checklists:write"] }, staff());
    expect(
      (
        await run<{ days: { run: string }[] }>(
          "x.dailychecks.history",
          { from: today(), to: today() },
          asUser(member),
        )
      ).days.map((d) => d.run),
    ).toContain(missed?.id);
  });

  it("every manager hears of a missed day, however many accounts hold other grants", async () => {
    // More accounts with some other grant than a read of the managers once took (500), each
    // before this manager in the order it read them (older ids).
    const now = new Date().toISOString();
    const ids = Array.from({ length: 520 }, (_, i) => newId("user", 1_000_000 + i));
    await env.DB.prepare(
      `INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role, granted_permissions)
       SELECT j.value, 'Granted ' || j.key, 'granted' || j.key || '@example.com', 1, ?1, ?1, 'member', '["records:publish"]' FROM json_each(?2) j`,
    )
      .bind(now, JSON.stringify(ids))
      .run();
    const manager = await account(unique("Zed Ze"));
    await run(
      "user.setPermissions",
      { id: manager.id, permissions: ["checklists:write"] },
      staff(),
    );
    const name = unique("Heard ");
    const id = await scheduled([{ text: "Lights" }], undefined, { name });
    await cron();
    const open = await runRow(id);
    await cron(new Date((Number(open?.closes) + 1) * 1000));
    const told = await env.DB.prepare(
      "SELECT user_id FROM core_notifications WHERE body LIKE ? AND user_id = ?",
    )
      .bind(`%${name}%`, manager.id)
      .all();
    expect(told.results).toHaveLength(1);
  });
});

describe("after the business's time zone is moved", () => {
  it("today's checklist is the run its day already has, so the screen never invites a tick the host refuses", async () => {
    const id = await scheduled([{ text: "Sweep the porch" }]);
    // Yesterday's run, made and then missed; today's, made.
    await cron(new Date(Date.now() - DAY));
    await cron();
    const person = await account(unique("Mover Mo"));
    try {
      // West by most of a day: here it is now (most hours) the day that was just missed.
      await run("settings.update", { timezone: "Pacific/Honolulu" }, staff());
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Honolulu" }).format(
        new Date(),
      );
      const row = await runRow(id, date);
      expect(row).not.toBeNull();
      const item = await itemOf(person, id);
      expect(item?.date ?? date).toBe(date);
      expect(item).toMatchObject({ state: row?.state, canTick: row?.state === "open" });
      expect(item?.run?.id).toBe(row?.id);
      if (row?.state === "missed") {
        expect(await rule(tick(person, id, 0, { date }))).toBe("checklist_closed");
      }
      // The history finds it by its day too.
      const history = await run<{ days: { run: string; date: string }[] }>(
        "x.dailychecks.history",
        { from: date, to: date, template: id },
        staff(),
      );
      expect(history.days.map((d) => d.run)).toEqual([row?.id]);
    } finally {
      await run("settings.update", { timezone: ZONE }, staff());
    }
  });
});

// --- With Rostering installed --------------------------------------------------------------------------

describe("with Rostering installed", () => {
  beforeAll(async () => {
    await run("extension.install", { id: "rostering", shipped: true }, staff());
    await refreshSchemaRegistry(db.query);
  }, 120_000);

  it("a cleaner's pack role reaches the day's checklist meant for it, and nothing else", async () => {
    const id = await scheduled([{ text: "Clean the showers" }], {
      kind: "role",
      role: "rostering.team",
    });
    const forMembers = await scheduled([{ text: "Count stock" }], { kind: "role", role: "member" });
    const cleaner = await fixedRole(unique("Cleaner Cn"), "rostering.team");
    const listed = (await todayOf(cleaner)).items.map((i) => i.template.id);
    expect(listed).toContain(id);
    expect(listed).not.toContain(forMembers);
    expect((await tick(cleaner, id, 0)).finished).toBe(true);
    // The pack role still reaches nothing else of this pack.
    expect(
      (await refusal(run("x.dailychecks.history", { from: today(), to: today() }, asUser(cleaner))))
        .code,
    ).toBe("forbidden");
    // A member does not do the cleaners' checklist.
    expect(await itemOf(await account(unique("Desk De")), id)).toBeUndefined();
  });

  it("a duty's checklist is as it was, and the rosterers' list holds shifts' runs only", async () => {
    const duty = (
      await run<{ id: string }>(
        "record.create",
        {
          object: "rostering.duty",
          values: {
            name: unique("Cleaning "),
            checklist: (
              await run<{ id: string }>(
                "checklist.save",
                { name: unique("Duty list "), steps: [{ text: "Mop" }] },
                staff(),
              )
            ).id,
          },
        },
        staff(),
      )
    ).id;
    const person = await account(unique("Rostered Ro"));
    const startsAt = new Date(Date.now() - 10 * MINUTE).toISOString();
    const shift = (
      await run<{ id: string }>(
        "record.create",
        {
          object: "rostering.shift",
          values: {
            duty,
            startsAt,
            endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
            timezone: ZONE,
            staff: person.id,
          },
        },
        staff(),
      )
    ).id;
    await run(
      "x.rostering.tick",
      { object: "rostering.shift", id: shift, step: 0, state: "done" },
      asUser(person),
    );
    const runs = await run<{ runs: { object: string; record: string }[] }>(
      "x.rostering.checklistRuns",
      // From yesterday: just after midnight the shift (10 minutes ago) is on yesterday's date.
      { from: today(new Date(Date.now() - DAY)), to: today() },
      staff(),
    );
    expect(runs.runs.map((r) => r.object)).toEqual(expect.arrayContaining(["rostering.shift"]));
    expect(runs.runs.some((r) => r.object === "checklist.day")).toBe(false);
    expect(runs.runs.map((r) => r.record)).toContain(shift);
    // A day run is not a shift's: the rosterers' correction does not reach it (one missed above).
    const missed = await env.DB.prepare(
      "SELECT id FROM core_checklist_run WHERE object_type = 'checklist.day' AND state != 'open' LIMIT 1",
    ).first<{ id: string }>();
    expect(missed?.id).toEqual(expect.any(String));
    expect(
      await rule(run("x.rostering.checklistCorrect", { run: missed?.id, text: "Note" }, staff())),
    ).toBe("not_found");
  });
});

// --- What one call reads -----------------------------------------------------------------------------

/** Well under D1's 1,000 a call, for the largest input each takes. */
const CEILING = 250;

describe("what one call reads, at the largest input", () => {
  it("the cron making and closing 200 days of 50 steps, today's list and the history each stay well under D1's limit", async () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      text: `Step ${i + 1} ${"of a long day's checklist ".repeat(10)}`.slice(0, 300),
      note: i % 10 === 0,
    }));
    for (let i = 0; i < 200; i++) await scheduled(steps, { kind: "staff" }, { dueBy: "23:00" });
    const counted: Record<string, number> = {};
    const make = await queriesOf(() => cron());
    expect(make.outcome).toBe("ok");
    counted.cronMake = make.queries;
    for (const [label, call] of [
      ["today", () => run("x.dailychecks.today", {}, staff())],
      [
        "history",
        () =>
          run(
            "x.dailychecks.history",
            // 60 days of 24 hours back: across a clock change it is 61 local days ago, and the
            // range (at most 62 days) still holds just after midnight.
            { from: today(new Date(Date.now() - 60 * DAY)), to: today() },
            staff(),
          ),
      ],
      ["cron close", () => cron(new Date(Date.now() + 2 * DAY))],
    ] as const) {
      const c = await queriesOf(call);
      expect([label, c.outcome]).toEqual([label, "ok"]);
      counted[label] = c.queries;
    }
    for (const [label, n] of Object.entries(counted)) {
      expect([label, n < CEILING]).toEqual([label, true]);
    }
    // Every day made in one minute, and closed in the next ones (at most 200 a minute).
    const open = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_checklist_run WHERE object_type = 'checklist.day' AND state = 'open' AND closes <= ?",
    )
      .bind(Math.floor((Date.now() + 2 * DAY) / 1000))
      .first<{ n: number }>();
    expect(Number(open?.n)).toBeLessThanOrEqual(200);
    expect(Object.keys(counted).sort()).toEqual(["cron close", "cronMake", "history", "today"]);
    console.info(`statements per call: ${JSON.stringify(counted)}`);
  }, 300_000);
});
