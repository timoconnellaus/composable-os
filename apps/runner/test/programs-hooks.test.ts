// Stage 41, step 5: the Programs pack's headless entry against the real host, the way the blocks
// call it: a coach builds and publishes through the hooks (the working copy's faults by path, the
// publish offer from user.me), assigns, and a member does a session through them. React stand-ins
// run each hook's query or mutation once. What never runs here is React itself and a browser:
// the web blocks render under Playwright (apps/app/e2e/programs.spec.ts), the native ones never.
import type {
  ActingUser,
  CustomerPrincipal,
  InvocationContext,
  OutsideInvocationContext,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import customer from "../../../packages/core/api/v1/customer.json";
import roles from "../../../packages/core/api/v1/roles.json";
import {
  createProgramsHooks,
  emptyLayout,
  faultsOf,
  PROGRAMS_HOOKS_CALL as HOOKS_CALL,
  layoutEdits,
  type ProgramsClient,
} from "../../../packs/programs/client/index.ts";
import { createAdmin, unique } from "./helpers.ts";
import {
  as,
  create,
  createCustomer,
  EXERCISE,
  installPrograms,
  refusal,
  run,
  staff,
} from "./programs-fixture.ts";

/** Every operation any hook calls: what the staff client holds (ADR 0453). */
const EVERY = Object.values(HOOKS_CALL).flatMap((calls) =>
  "anyOf" in calls ? calls.anyOf.flat() : [...calls],
);

function hostClient(
  ctx: InvocationContext | OutsideInvocationContext,
  held: readonly string[] = EVERY,
): ProgramsClient & { operations: Record<string, unknown> } {
  return {
    // Every operation unless told otherwise: these tests run every hook.
    operations: Object.fromEntries(held.map((n) => [n, true])),
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

function hooksFor(ctx: InvocationContext | OutsideInvocationContext, held?: readonly string[]) {
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
    hostClient(ctx, held),
  );
  return { hooks, last: <T>() => (queries.at(-1) as () => Promise<T>)() };
}

let admin: ActingUser;
let coach: ActingUser;
let member: CustomerPrincipal;
let row: string;

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  const id = `usr_${unique("coach")}`;
  const { env } = await import("cloudflare:workers");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Coach', ?, 1, ?, ?, 'member')",
  )
    .bind(id, `${id}@example.com`, now, now)
    .run();
  coach = { id, email: `${id}@example.com`, name: "Coach", role: "member" };
  row = await create(admin, EXERCISE, { name: "Ring row", measure: "weight_reps" });
  member = await createCustomer(admin, "hooks", "Hana");
}, 120_000);

/** A staff account a human admin gave Programs' coach role (ADR 0889). */
async function coachRole(): Promise<ActingUser> {
  const id = `usr_${unique("kim")}`;
  const { env } = await import("cloudflare:workers");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Coach Kim', ?, 1, ?, ?, 'member')",
  )
    .bind(id, `${id}@example.com`, now, now)
    .run();
  await run("user.setPackRole", { id, role: "programs.coach" }, staff(admin));
  return { id, email: `${id}@example.com`, name: "Coach Kim", role: "viewer" };
}

/** One week of one session: a row of one set. */
function oneSession() {
  let layout = layoutEdits.addSession(emptyLayout(), 0);
  layout = layoutEdits.addBlock(layout, { week: 0, session: 0 });
  return layoutEdits.addItem(layout, { week: 0, session: 0, block: 0 }, row, "weight_reps");
}

describe("the hooks against the host", () => {
  it("a coach builds, sees the host's fault where it is, is offered publish once granted, and assigns", async () => {
    const c = hooksFor(staff(coach));
    const program = await c.hooks.useCreateProgram().mutateAsync({
      object: "programs.program",
      values: { title: "Hooks block", kind: "client", layout: emptyLayout() },
    });
    let layout = layoutEdits.addSession(emptyLayout(), 0);
    layout = layoutEdits.setSession(layout, { week: 0, session: 0 }, { day: 9 });
    const refused = await refusal(
      run(
        "record.update",
        { object: "programs.program", id: program.id, values: { layout } },
        staff(coach),
      ),
    );
    expect([...faultsOf({ message: refused.message, details: refused.details })]).toEqual([
      ["weeks.0.sessions.0.day", "At most 7"],
    ]);
    layout = layoutEdits.setSession(layout, { week: 0, session: 0 }, { day: 1 });
    layout = layoutEdits.addBlock(layout, { week: 0, session: 0 });
    layout = layoutEdits.addItem(layout, { week: 0, session: 0, block: 0 }, row, "weight_reps");
    await run(
      "record.update",
      { object: "programs.program", id: program.id, values: { layout } },
      staff(coach),
    );
    // Publishing is offered only to an account that holds the permission, and the host decides.
    c.hooks.usePublishOffered();
    expect((await c.last<{ permissions: string[] }>()).permissions).not.toContain(
      "records:publish",
    );
    expect(
      await refusal(
        c.hooks.usePublish().mutateAsync({ object: "programs.program", id: program.id }),
      ),
    ).toMatchObject({
      code: "forbidden",
    });
    await run(
      "user.setPermissions",
      { id: coach.id, permissions: ["records:publish"] },
      staff(admin),
    );
    c.hooks.usePublishOffered();
    expect((await c.last<{ permissions: string[] }>()).permissions).toContain("records:publish");
    expect(
      (await c.hooks.usePublish().mutateAsync({ object: "programs.program", id: program.id }))
        .version,
    ).toBe(1);
    c.hooks.useVersions(program.id);
    expect((await c.last<{ items: unknown[] }>()).items).toHaveLength(1);
    const assigned = await c.hooks.useAssign().mutateAsync({
      programId: program.id,
      personId: member.personId,
      startDate: "2027-09-06",
    });
    expect(assigned).toMatchObject({ sessions: 1, programVersion: 1 });
    c.hooks.useClientSessions(member.personId);
    expect((await c.last<{ items: unknown[] }>()).items).toHaveLength(1);
  });

  it("a member does the session through the hooks, and sees it in their progress", async () => {
    const m = hooksFor(as(member));
    m.hooks.useToday({ date: "2027-09-06" });
    const today = await m.last<{ sessions: { id: string; programTitle: string | null }[] }>();
    expect(today.sessions[0]?.programTitle).toBe("Hooks block");
    const sessionId = today.sessions[0]?.id as string;
    m.hooks.useSession({ sessionId });
    const detail = await m.last<{ exercises: { name: string | null }[] }>();
    expect(detail.exercises.map((e) => e.name)).toEqual(["Ring row"]);
    const set = await m.hooks
      .useLogSet()
      .mutateAsync({ sessionId, item: "A1", setNumber: 1, actual: { reps: 8, load: 20 }, rpe: 7 });
    expect(set).toMatchObject({ exerciseName: "Ring row", target: { reps: 8 } });
    await m.hooks.useMarkSession().mutateAsync({ sessionId, state: "done" });
    m.hooks.useProgress();
    const progress = await m.last<{ assignments: { done: number }[] }>();
    expect(progress.assignments[0]?.done).toBe(1);
    m.hooks.useHistory({ exerciseId: row });
    expect((await m.last<{ sets: unknown[] }>()).sets).toHaveLength(1);
  });

  it("each audience's client reads the class types its own way: a member my.list, staff record.list", async () => {
    await run(
      "record.create",
      { object: "programs.classtype", values: { name: "Hooks class", order: 1 } },
      staff(admin),
    );
    // A member's client holds what the customer contract serves, and no record.list.
    const served = new Set(customer.operations.map((o) => o.name));
    const memberHolds = EVERY.filter((n) => served.has(n));
    expect(memberHolds).toContain("my.list");
    expect(memberHolds).not.toContain("record.list");
    const m = hooksFor(as(member), memberHolds);
    expect(Object.keys(m.hooks)).toEqual(
      expect.arrayContaining(["useClassTypes", "useClassToday"]),
    );
    m.hooks.useClassTypes();
    const forMember = await m.last<{ items: { values: Record<string, unknown> }[] }>();
    expect(forMember.items.map((t) => t.values.name)).toContain("Hooks class");
    // Staff, holding both, read with record.list (a member's read is refused to staff).
    const c = hooksFor(staff(coach));
    c.hooks.useClassTypes();
    const forStaff = await c.last<{ items: { values: Record<string, unknown> }[] }>();
    expect(forStaff.items.map((t) => t.values.name)).toContain("Hooks class");
    // A client holding neither has no such hook.
    const none = hooksFor(as(member), ["x.programs.classToday"]);
    expect("useClassTypes" in none.hooks).toBe(false);
  });

  it("the coach role's client backs the coach's client view and session screen, and nothing else", async () => {
    const holds = roles.roles.find((r) => r.name === "programs.coach")?.operations ?? [];
    const k = await coachRole();
    const hooks = hooksFor(staff(k), holds);
    // Its client types record.list to its own objects (cos client generate); the bank's and the
    // programs' hooks are there by name and the host refuses them (the role reads neither).
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      [
        "useBank",
        "useClassTypes",
        "useClientPastSessions",
        "useClientSessions",
        "useExercises",
        "useHistory",
        "useLogSet",
        "useMarkSession",
        "usePrograms",
        "useProgress",
        "useSession",
        "useSessionLog",
        "useToday",
        "useUnsavedSets",
        "useUpdateSet",
      ].sort(),
    );
    hooks.hooks.useBank();
    expect(await refusal(hooks.last())).toMatchObject({ code: "forbidden" });
    for (const absent of ["useAssign", "usePeople", "usePublish", "useDraft", "useClassToday"]) {
      expect(absent in hooks.hooks, absent).toBe(false);
    }
    // Its own client's sessions; a client it does not coach has none to show.
    const program = await run<{ id: string }>(
      "record.create",
      {
        object: "programs.program",
        values: { title: "Coached by hooks", kind: "client", layout: oneSession() },
      },
      staff(admin),
    );
    await run("record.publish", { object: "programs.program", id: program.id }, staff(admin));
    const theirs = await createCustomer(admin, "coached", "Cora");
    const { assignmentId } = await run<{ assignmentId: string }>(
      "x.programs.assign",
      { programId: program.id, personId: theirs.personId, startDate: "2027-10-04" },
      staff(admin),
    );
    await run(
      "record.update",
      { object: "programs.assignment", id: assignmentId, values: { coach: k.id } },
      staff(admin),
    );
    hooks.hooks.useClientSessions(theirs.personId);
    const sessions = await hooks.last<{ items: { id: string }[] }>();
    expect(sessions.items).toHaveLength(1);
    const sessionId = sessions.items[0]?.id as string;
    hooks.hooks.useSession({ sessionId });
    expect((await hooks.last<{ session: { id: string } }>()).session.id).toBe(sessionId);
    const set = await hooks.hooks
      .useLogSet()
      .mutateAsync({ sessionId, item: "A1", setNumber: 1, actual: { reps: 8, load: 20 } });
    expect(set).toMatchObject({ recordedAs: "staff" });
    hooks.hooks.useClientSessions(member.personId);
    expect((await hooks.last<{ items: unknown[] }>()).items).toEqual([]);
  });
});
