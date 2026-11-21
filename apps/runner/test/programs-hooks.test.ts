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

function hostClient(
  ctx: InvocationContext | OutsideInvocationContext,
): ProgramsClient & { operations: Record<string, unknown> } {
  return {
    // Every operation: these tests run every hook (ADR 0453).
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
});
