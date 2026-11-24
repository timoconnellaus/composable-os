// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are extension source text; their template literals run in the sandbox.
// An automation that runs only with another extension (ADR 0812, stage 54 P3): the extension
// installs without it, the automation is listed as waiting and starts no run (an event, a button,
// a queued run), and it runs once the other extension is installed and on, and waits again while
// that one is disabled. Real D1, Workflows (introspected) and Worker Loader, through
// extension.install.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationDefinition,
  type AutomationListItem,
  loadEnabledAutomations,
  memoryRateLimit,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { runDeferredDue, startRuns } from "../src/automations/dispatch.ts";
import { automationHost } from "../src/automations/host.ts";
import { dispatch, runsOf, runWorkflows, tasksOn, withEvents } from "./automation-fixture.ts";
import { call, createAdmin, db, install } from "./helpers.ts";

// The extension the automation runs only with (as Bookings is for Reviews).
const BASE = "owbase";
const VISIT = `${BASE}.visit`;
// The extension whose automation waits for it.
const USER = "owuser";

const BASE_FILES: Record<string, string> = {
  "index.ts": `import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "${BASE}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Visits",
  objects: {
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "booked", label: "Booked" },
            { value: "attended", label: "Attended" },
          ],
        },
      },
    },
  },
});
`,
};

const USER_FILES: Record<string, string> = {
  "index.ts": `import { defineAutomation, defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "${USER}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Thank-yous",
  objects: {
    note: {
      label: "Note",
      plural: "Notes",
      titleField: "name",
      fields: { name: { type: "text", label: "Name" } },
    },
  },
  permissions: {
    read: ["${VISIT}", "person", "task"],
    write: ["task"],
    operations: [],
    modules: ["ops"],
  },
  automations: {
    afterVisit: defineAutomation({
      label: "After a visit",
      description: "When a visit is attended, a thank-you task.",
      onlyWith: ["${BASE}"],
      trigger: { type: "fieldChanged", object: "${VISIT}", field: "state", to: "attended" },
      steps: [{ name: "thank", reads: ["${VISIT}"], writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("thank", () =>
          ctx.ops.call("task.create", {
            title: \`Thank \${String(event.record?.data?.name)}\`,
            links: event.record ? [{ object: event.record.object, id: event.record.id }] : [],
          }),
        );
      },
    }),
    byHand: defineAutomation({
      label: "Thank by hand",
      description: "A thank-you task for a person, from their page.",
      onlyWith: ["${BASE}"],
      trigger: { type: "manual", object: "person", label: "Thank" },
      steps: [{ name: "thank", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("thank", () =>
          ctx.ops.call("task.create", {
            title: "Thank by hand",
            links: event.record ? [{ object: "person", id: event.record.id }] : [],
          }),
        );
      },
    }),
    always: defineAutomation({
      label: "Every note",
      description: "Runs with this extension alone.",
      trigger: { type: "record", object: "${USER}.note", on: ["created"] },
      steps: [{ name: "thank", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("thank", () => ctx.ops.call("task.create", { title: "Note" }));
      },
    }),
  },
});
`,
};

let admin: ActingUser;
/** A completed run of byHand, made once the other extension is installed. */
let byHandRun = "";
const MINUTE = 60_000;

async function listed(): Promise<Record<string, AutomationListItem>> {
  const { items } = await call<{ items: AutomationListItem[] }>(admin, "automation.list", {
    extensionId: USER,
  });
  return Object.fromEntries(items.map((item) => [item.key, item]));
}

async function enabledIds(): Promise<string[]> {
  return (await loadEnabledAutomations(db.query, ["fieldChanged", "record"]))
    .map((a) => a.id)
    .filter((id) => id.startsWith(`${USER}.`))
    .sort();
}

async function attendedVisit(name: string): Promise<string> {
  const { result: visit } = await withEvents<{ id: string }>(admin, "record.create", {
    object: VISIT,
    values: { name, state: "booked" },
  });
  const { messages } = await withEvents(admin, "record.update", {
    object: VISIT,
    id: visit.id,
    values: { state: "attended" },
  });
  await runWorkflows(() => dispatch(messages));
  return visit.id;
}

async function person(): Promise<string> {
  const created = await call<{ id: string }>(admin, "person.create", {
    displayName: `Thanked ${crypto.randomUUID().slice(0, 6)}`,
  });
  return created.id;
}

beforeAll(async () => {
  admin = await createAdmin();
});

describe("onlyWith (ADR 0812)", () => {
  it("installs without the extension it runs only with; that automation waits, the others run", async () => {
    const result = await install(admin, USER, USER_FILES);
    expect(result.id).toBe(USER);
    const items = await listed();
    expect(items.afterVisit).toMatchObject({ status: "waiting", waitingFor: [BASE] });
    expect(items.byHand).toMatchObject({ status: "waiting", waitingFor: [BASE] });
    expect(items.always).toMatchObject({ status: "active", waitingFor: [] });
    const detail = await call<AutomationListItem>(admin, "automation.get", {
      id: `${USER}.afterVisit`,
    });
    expect(detail).toMatchObject({ status: "waiting", waitingFor: [BASE] });
    expect(await enabledIds()).toEqual([`${USER}.always`]);
    // Not a button on a person's page while it waits, and a direct start starts nothing.
    const { items: buttons } = await call<{ items: AutomationListItem[] }>(
      admin,
      "automation.list",
      { manualFor: "person" },
    );
    expect(buttons.map((b) => b.id)).not.toContain(`${USER}.byHand`);
    const id = await person();
    const out = await call<{ runIds: string[] }>(admin, "automation.run", {
      id: `${USER}.byHand`,
      object: "person",
      recordIds: [id],
    });
    expect(out.runIds).toEqual([]);
    expect(await tasksOn(id)).toEqual([]);
  });

  it("runs once the other extension is installed and on", async () => {
    await install(admin, BASE, BASE_FILES);
    const items = await listed();
    expect(items.afterVisit).toMatchObject({ status: "active", waitingFor: [] });
    expect(await enabledIds()).toEqual([`${USER}.afterVisit`, `${USER}.always`]);
    const visit = await attendedVisit("Sam");
    expect(await tasksOn(visit)).toEqual(["Thank Sam"]);
    const id = await person();
    const done = await runWorkflows(() =>
      call<{ runIds: string[] }>(admin, "automation.run", {
        id: `${USER}.byHand`,
        object: "person",
        recordIds: [id],
      }),
    );
    expect(await tasksOn(id)).toEqual(["Thank by hand"]);
    byHandRun = done.runIds[0] as string;
  });

  it("waits again while the other extension is disabled, and keeps a person's on or off", async () => {
    // An event raised while the other extension is still on, dispatched after it is turned off.
    const { result: visit } = await withEvents<{ id: string }>(admin, "record.create", {
      object: VISIT,
      values: { name: "Kim", state: "booked" },
    });
    const { messages } = await withEvents(admin, "record.update", {
      object: VISIT,
      id: visit.id,
      values: { state: "attended" },
    });
    await call(admin, "extension.disable", { id: BASE });
    try {
      expect((await listed()).afterVisit).toMatchObject({ status: "waiting", waitingFor: [BASE] });
      expect(await enabledIds()).toEqual([`${USER}.always`]);
      const started = await dispatch(messages);
      expect(started.runIds).toEqual([]);
      expect(await tasksOn(visit.id)).toEqual([]);
      // Turned off by a person, it says so; turned on again, it still waits.
      await call(admin, "automation.disable", { id: `${USER}.afterVisit` });
      expect((await listed()).afterVisit?.status).toBe("disabled");
      const enabled = await call<{ status: string }>(admin, "automation.enable", {
        id: `${USER}.afterVisit`,
      });
      expect(enabled.status).toBe("waiting");
    } finally {
      await call(admin, "extension.enable", { id: BASE });
    }
    expect((await listed()).afterVisit?.status).toBe("active");
  });

  it("refuses a retry or a replay while it waits (review of PR #420)", async () => {
    await call(admin, "extension.disable", { id: BASE });
    try {
      for (const name of ["automation.replay", "automation.retry"]) {
        const refused = await withEvents(admin, name, { runId: byHandRun }).catch(
          (error: { code?: string; message?: string }) => error,
        );
        expect(refused).toMatchObject({
          code: "invalid_input",
          message: expect.stringContaining(`runs only with ${BASE}`),
        });
      }
      // The runner refuses too, for a caller that reaches it without the operation.
      await expect(automationHost(env).replayRun(byHandRun)).rejects.toThrow(
        `runs only with ${BASE}`,
      );
      expect((await runsOf(`${USER}.byHand`)).length).toBe(1);
    } finally {
      await call(admin, "extension.enable", { id: BASE });
    }
  });

  it("keeps runs held by the rate rail queued, counted as waiting, until the other is on", async () => {
    const byHand = (await loadEnabledAutomations(db.query, ["manual"])).find(
      (a) => a.id === `${USER}.byHand`,
    ) as AutomationDefinition;
    const ids = [await person(), await person()];
    const held = await startRuns(
      { ...env, AUTOMATION_RATE_LIMIT: memoryRateLimit(0) },
      ids.map((id, i) => ({
        automation: byHand,
        idempotencyKey: `onlywith-held:${i}`,
        record: { object: "person", id },
      })),
      { depth: 0, chain: [], rootEventId: "ow", eventId: "ow", at: new Date().toISOString() },
    );
    expect(held.deferred).toBe(2);
    const allowAll = { ...env, AUTOMATION_RATE_LIMIT: memoryRateLimit(100_000) };
    const later = new Date(Date.now() + 2 * MINUTE);
    await call(admin, "extension.disable", { id: BASE });
    try {
      expect(await runDeferredDue(allowAll, later)).toEqual({ started: 0, waiting: 2 });
    } finally {
      await call(admin, "extension.enable", { id: BASE });
    }
    const drained = await runWorkflows(() => runDeferredDue(allowAll, later));
    expect(drained).toEqual({ started: 2, waiting: 0 });
    for (const id of ids) expect(await tasksOn(id)).toEqual(["Thank by hand"]);
  });

  it("costs one more read, by primary key, only when a matched automation names onlyWith", async () => {
    const statements: string[] = [];
    const metered = createCrmDb(
      new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (query: string) => {
              statements.push(query);
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    await loadEnabledAutomations(metered.query, ["record"], [`${USER}.note`]);
    expect(statements).toHaveLength(1);
    statements.length = 0;
    await loadEnabledAutomations(metered.query, ["fieldChanged"], [VISIT]);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/from "core_extensions" where "id" in/);
  });
});

// Review of PR #420, finding 1: an extension checked while the other was not installed may name
// an object the other does not have. Nothing checks it again when the other is installed, so the
// list says so instead of calling it active.
const BAD_BASE = "owbadbase";
const BAD_USER = "owbaduser";

describe("onlyWith naming an object the other extension does not have (ADR 0812)", () => {
  it("is listed as broken, with the objects, once the other extension is installed", async () => {
    await install(admin, BAD_USER, {
      "index.ts": (USER_FILES["index.ts"] as string)
        .replaceAll(USER, BAD_USER)
        .replaceAll(`${BASE}.visit"`, `${BAD_BASE}.visits"`)
        .replaceAll(`"${BASE}"`, `"${BAD_BASE}"`)
        .replace('write: ["task"]', `write: ["task", "${BAD_BASE}.nosuch"]`),
    });
    const before = await call<{ items: AutomationListItem[] }>(admin, "automation.list", {
      extensionId: BAD_USER,
    });
    expect(before.items.find((i) => i.key === "afterVisit")).toMatchObject({
      status: "waiting",
      unknownObjects: [],
    });
    await install(admin, BAD_BASE, {
      "index.ts": (BASE_FILES["index.ts"] as string).replaceAll(BASE, BAD_BASE),
    });
    const { items } = await call<{ items: AutomationListItem[] }>(admin, "automation.list", {
      extensionId: BAD_USER,
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.afterVisit).toMatchObject({
      status: "broken",
      waitingFor: [],
      unknownObjects: [`${BAD_BASE}.nosuch`, `${BAD_BASE}.visits`],
    });
    // byHand names none of them itself, but its extension's permissions do.
    expect(byKey.byHand).toMatchObject({
      status: "broken",
      unknownObjects: [`${BAD_BASE}.nosuch`, `${BAD_BASE}.visits`],
    });
    expect(byKey.always).toMatchObject({ status: "active", unknownObjects: [] });
    const detail = await call<AutomationListItem>(admin, "automation.get", {
      id: `${BAD_USER}.afterVisit`,
    });
    expect(detail.status).toBe("broken");
    const enabled = await call<{ status: string }>(admin, "automation.enable", {
      id: `${BAD_USER}.afterVisit`,
    });
    expect(enabled.status).toBe("broken");
  });
});
