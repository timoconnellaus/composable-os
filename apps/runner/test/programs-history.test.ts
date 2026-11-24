// Stage 41: a person's past sessions, as the history blocks read them through the pack's client
// (`usePastSessions` for a member, `useClientPastSessions` for a coach, then `useSession` and
// `useUpdateSet`). Newest first, only their own personal sessions dated on or before `until`, with
// sets done of planned; a logged set corrected within logUpdate's rule (the numbers done, effort and
// the note; a member their own sets only); and what one page costs in statements and bound
// variables. React stand-ins run each hook's query or mutation once, as programs-hooks.test.ts.
import { env } from "cloudflare:workers";
import type {
  ActingUser,
  CustomerPrincipal,
  InvocationContext,
  OutsideInvocationContext,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  correctionOf,
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL as HOOKS_CALL,
  loadPastSessions,
  type PastSessionsPage,
  type ProgramsClient,
  type SessionDetail,
  sessionSets,
} from "../../../packs/programs/client/index.ts";
import type { Layout } from "../../../packs/programs/layout.ts";
import { createAdmin } from "./helpers.ts";
import {
  as,
  CLASSTYPE,
  create,
  createCustomer,
  EXERCISE,
  installPrograms,
  PROGRAM,
  refusal,
  run,
  staff,
  twoWeeks,
} from "./programs-fixture.ts";

function hostClient(
  ctx: InvocationContext | OutsideInvocationContext,
): ProgramsClient & { operations: Record<string, unknown> } {
  return {
    operations: Object.fromEntries(
      Object.values(HOOKS_CALL)
        .flat()
        .map((n) => [n, true]),
    ),
    query: ((name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: () => run(name, input, ctx),
    })) as ProgramsClient["query"],
    mutation: ((name: string) => ({
      mutationKey: [name],
      mutationFn: (input: unknown) => run(name, input, ctx),
    })) as ProgramsClient["mutation"],
  };
}

function hooksFor(ctx: InvocationContext | OutsideInvocationContext) {
  const queries: (() => Promise<unknown>)[] = [];
  const hooks = createProgramsHooks(
    {
      useQuery: (options) => {
        queries.push(options.queryFn as () => Promise<unknown>);
        return { data: undefined, isPending: true, error: null };
      },
      useMutation: (options) => ({
        mutate: (input) => void options.mutationFn(input),
        mutateAsync: options.mutationFn,
        data: undefined,
        isPending: false,
        error: null,
      }),
      useState: <T>(initial: T) => [initial, () => undefined],
    },
    hostClient(ctx),
  );
  return { hooks, last: <T>() => (queries.at(-1) as () => Promise<T>)() };
}

let admin: ActingUser;
let ada: CustomerPrincipal;
let ben: CustomerPrincipal;
let bank: { row: string; pike: string };
let adaSessions: { id: string; date: string; name: string }[];

const assign = async (programId: string, input: Record<string, unknown>) =>
  run<{ assignmentId: string }>("x.programs.assign", { programId, ...input }, staff(admin));

const sessionsOf = async (assignmentId: string) =>
  (
    await run<{ items: { id: string; values: { date: string; name: string } }[] }>(
      "record.list",
      {
        object: "programs.session",
        filter: { field: "assignment", op: "eq", value: assignmentId },
        sort: { field: "date", direction: "asc" },
      },
      staff(admin),
    )
  ).items.map((s) => ({ id: s.id, ...s.values }));

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  bank = {
    row: await create(admin, EXERCISE, { name: "Ring row", measure: "weight_reps" }),
    pike: await create(admin, EXERCISE, { name: "Pike press", measure: "reps" }),
  };
  ada = await createCustomer(admin, "history-ada", "Ada");
  ben = await createCustomer(admin, "history-ben", "Ben");
  const id = await create(admin, PROGRAM, {
    title: "History block",
    kind: "client",
    layout: twoWeeks(bank),
  });
  await run("record.publish", { object: PROGRAM, id }, staff(admin));
  // Ada's two weeks from Monday 2027-05-03: the 3rd, 6th, 10th and 13th.
  const mine = await assign(id, { personId: ada.personId, startDate: "2027-05-03" });
  adaSessions = await sessionsOf(mine.assignmentId);
  // Ben's, on the same dates, and a class's: neither is in Ada's history.
  await assign(id, { personId: ben.personId, startDate: "2027-05-03" });
  const classProgram = await create(admin, PROGRAM, {
    title: "Class block",
    kind: "class",
    layout: twoWeeks(bank),
  });
  await run("record.publish", { object: PROGRAM, id: classProgram }, staff(admin));
  const handstands = await create(admin, CLASSTYPE, { name: "Handstands", order: 1 });
  await assign(classProgram, { classTypeId: handstands, startDate: "2027-05-03" });
  // Ada logs on her first two sessions: both rows of the first, one row and level 3 of the second.
  const [first, second] = adaSessions;
  const log = (sessionId: string, values: Record<string, unknown>) =>
    run("x.programs.logAdd", { sessionId, ...values }, as(ada));
  await log(first?.id as string, {
    item: "A1",
    setNumber: 1,
    actual: { reps: 8, load: 20 },
    rpe: 7,
  });
  await log(first?.id as string, {
    item: "A1",
    setNumber: 2,
    actual: { reps: 7, load: 20 },
    rpe: 8,
  });
  await log(first?.id as string, { item: "A2", level: 1, setNumber: 1, actual: { reps: 5 } });
  await log(second?.id as string, { item: "A1", level: 1, setNumber: 1, actual: { reps: 4 } });
  await run("x.programs.sessionComplete", { sessionId: first?.id, state: "done" }, as(ada));
  // Ben logs on his first session too.
  const bens = await run<{ sessions: { id: string }[] }>(
    "x.programs.today",
    { date: "2027-05-03" },
    as(ben),
  );
  await run(
    "x.programs.logAdd",
    { sessionId: bens.sessions[0]?.id, item: "A1", setNumber: 1, actual: { reps: 3 } },
    as(ben),
  );
}, 180_000);

describe("past sessions", () => {
  it("a member sees their own past sessions newest first, with sets done of planned", async () => {
    const m = hooksFor(as(ada));
    m.hooks.usePastSessions({ until: "2027-05-10" });
    const page = await m.last<PastSessionsPage>();
    // The 13th is after `until`; Ben's and the class's sessions are not hers.
    expect(page.sessions.map((s) => [s.date, s.name, s.setsDone, s.setsPlanned, s.state])).toEqual([
      ["2027-05-10", "Press 2", 0, 3, "planned"],
      ["2027-05-06", "Pull 1", 1, 1, "planned"],
      ["2027-05-03", "Press 1", 3, 3, "done"],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("a coach sees a client's the same way, and only that client's", async () => {
    const c = hooksFor(staff(admin));
    c.hooks.useClientPastSessions(ada.personId, { until: "2027-05-31" });
    const page = await c.last<PastSessionsPage>();
    expect(page.sessions.map((s) => [s.date, s.setsDone])).toEqual([
      ["2027-05-13", 0],
      ["2027-05-10", 0],
      ["2027-05-06", 1],
      ["2027-05-03", 3],
    ]);
    c.hooks.useClientPastSessions(ben.personId, { until: "2027-05-03" });
    expect((await c.last<PastSessionsPage>()).sessions.map((s) => s.setsDone)).toEqual([1]);
  });

  it("one opened shows set by set, and a member corrects their own set within logUpdate's rule", async () => {
    const m = hooksFor(as(ada));
    const sessionId = adaSessions[0]?.id as string;
    m.hooks.useSession({ sessionId });
    const detail = await m.last<SessionDetail>();
    const sets = sessionSets(detail.session.plan as never, detail.logged);
    expect(sets.map((s) => [s.item, s.setNumber, s.level, s.logged?.actual.reps ?? null])).toEqual([
      ["A1", 1, null, 8],
      ["A1", 2, null, 7],
      ["A2", 1, 1, 5],
    ]);
    const second = sets[1]?.logged;
    if (!second) throw new Error("no second set");
    const correction = correctionOf(
      second,
      { count: "8", load: "22.5", rpe: "8", note: "Grip" },
      false,
    );
    expect(correction).toEqual({
      logId: second.id,
      actual: { reps: 8, load: 22.5 },
      note: "Grip",
    });
    const corrected = await m.hooks.useUpdateSet().mutateAsync(correction as never);
    // What was done changes; the target, the exercise and who recorded it stay.
    expect(corrected).toMatchObject({
      actual: { reps: 8, load: 22.5 },
      note: "Grip",
      target: { reps: 8, load: 20 },
      exercise: bank.row,
      recordedAs: "self",
    });
    // The host bounds the numbers for a correction as for a log.
    expect(
      await refusal(m.hooks.useUpdateSet().mutateAsync({ logId: second.id, rpe: 50 })),
    ).toMatchObject({ code: "invalid_input" });
    // And another person's set is not theirs to correct.
    const bens = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: "programs.log", filter: { field: "person", op: "eq", value: ben.personId } },
      staff(admin),
    );
    const refused = await refusal(
      m.hooks.useUpdateSet().mutateAsync({ logId: bens.items[0]?.id as string, rpe: 6 }),
    );
    expect(refused.inner).toBe("not_found");
  });

  it("a coach opens a client's session and corrects a set; it stays the member's own record", async () => {
    const c = hooksFor(staff(admin));
    c.hooks.useSession({ sessionId: adaSessions[1]?.id as string });
    const detail = await c.last<SessionDetail>();
    const set = detail.logged[0];
    if (!set) throw new Error("no set");
    const corrected = await c.hooks
      .useUpdateSet()
      .mutateAsync(correctionOf(set, { count: "5", load: "", rpe: "", note: "" }, false) as never);
    expect(corrected).toMatchObject({ actual: { reps: 5 }, recordedAs: "self" });
    const m = hooksFor(as(ada));
    m.hooks.usePastSessions({ until: "2027-05-06" });
    expect((await m.last<PastSessionsPage>()).sessions[0]).toMatchObject({
      date: "2027-05-06",
      setsDone: 1,
    });
  });
});

// --- What one page costs (D1: 1,000 queries a call, 100 bound variables a statement) ------------

/** The statements `call` prepares against D1, and the most variables any one of them binds. */
async function costOf(call: () => Promise<unknown>): Promise<{ queries: number; bound: number }> {
  type Statement = { bind: (...args: unknown[]) => Statement };
  const d1 = env.DB as unknown as { prepare: (...a: unknown[]) => Statement };
  const prepare = d1.prepare.bind(d1);
  let queries = 0;
  let bound = 0;
  d1.prepare = (...a: unknown[]) => {
    queries++;
    const statement = prepare(...a);
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      bound = Math.max(bound, args.length);
      return bind(...args);
    };
    return statement;
  };
  try {
    await call();
    return { queries, bound };
  } finally {
    d1.prepare = prepare;
  }
}

describe("what a page of history costs", () => {
  it("a full page of 20 sessions with many sets each stays well under D1's limits", async () => {
    // Six weeks of four sessions, each with 12 sets of one exercise: 24 sessions, all logged.
    const layout: Layout = {
      weeks: Array.from({ length: 6 }, (_, w) => ({
        sessions: [1, 2, 4, 5].map((day) => ({
          name: `Load ${w + 1}.${day}`,
          day,
          blocks: [
            {
              label: "A",
              items: [
                {
                  kind: "all" as const,
                  label: "A1",
                  exercises: [
                    {
                      exercise: bank.row,
                      sets: Array.from({ length: 12 }, () => ({ kind: "reps" as const, reps: 5 })),
                    },
                  ],
                },
              ],
            },
          ],
        })),
      })),
    };
    const cy = await createCustomer(admin, "history-load", "Cy");
    const id = await create(admin, PROGRAM, { title: "Load", kind: "client", layout });
    await run("record.publish", { object: PROGRAM, id }, staff(admin));
    const { assignmentId } = await assign(id, { personId: cy.personId, startDate: "2027-06-07" });
    const sessions = await sessionsOf(assignmentId);
    expect(sessions).toHaveLength(24);
    for (const s of sessions) {
      for (let n = 1; n <= 12; n += 1) {
        await run(
          "x.programs.logAdd",
          { sessionId: s.id, item: "A1", setNumber: n, actual: { reps: 5 } },
          as(cy),
        );
      }
    }
    // A member's page and a coach's: 20 sessions and their 240 sets (two pages of sets).
    const read =
      (ctx: InvocationContext | OutsideInvocationContext, name: string) => (input: unknown) =>
        run(name, input, ctx) as never;
    let page: PastSessionsPage | undefined;
    const member = await costOf(async () => {
      page = await loadPastSessions(read(as(cy), "my.list"), { until: "2027-12-31" });
    });
    expect(page?.sessions).toHaveLength(20);
    expect(page?.sessions.every((s) => s.setsDone === 12 && s.setsPlanned === 12)).toBe(true);
    expect(page?.nextCursor).toBeTruthy();
    const coach = await costOf(() =>
      loadPastSessions(read(staff(admin), "record.list"), {
        personId: cy.personId,
        until: "2027-12-31",
      }),
    );
    for (const cost of [member, coach]) {
      expect(cost.queries).toBeGreaterThan(0);
      expect(cost.queries).toBeLessThan(100);
      expect(cost.bound).toBeGreaterThan(0);
      expect(cost.bound).toBeLessThan(60);
    }
    // The next page has the last four.
    const older = await loadPastSessions(read(as(cy), "my.list"), {
      until: "2027-12-31",
      cursor: page?.nextCursor as string,
    });
    expect(older.sessions).toHaveLength(4);
    expect(older.nextCursor).toBeNull();
  }, 300_000);
});
