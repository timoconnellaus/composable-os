// Stage 39 step 1, acceptance criterion 1 (ADR 0750): a stage may require a read-only field, a
// fact only the host sets. A job on a Trades-like pipeline cannot be moved into Accepted, Signed
// off or Paid by a person, an MCP client (directly or through the approval queue), an extension's
// code or an import until the host has set the fact; the refusal names the missing fact. Once it
// is set, staff make the move; platform code may set it and move in the one write.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  defineOperation,
  invokeByName,
  invokeOperation,
  updateRecordAsHost,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

const ext = extId("hf");
const JOB = `${ext}.job`;
const STEP = `${ext}.step`;

const OBJECTS = {
  step: {
    label: "Step",
    plural: "Steps",
    titleField: "name",
    navigation: "settings",
    fields: {
      name: { type: "text", label: "Name", required: true },
      type: {
        type: "select",
        label: "Type",
        options: [
          { value: "open", label: "Open" },
          { value: "won", label: "Won" },
          { value: "lost", label: "Lost" },
        ],
      },
      position: { type: "number", label: "Position" },
      needs: {
        type: "multiSelect",
        label: "Needs",
        options: [
          { value: "summary", label: "Summary" },
          { value: "acceptedAt", label: "Accepted at" },
          { value: "signedOffAt", label: "Signed off at" },
        ],
      },
    },
  },
  job: {
    label: "Job",
    plural: "Jobs",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      step: { type: "relation", label: "Step", to: `${ext}.step` },
      summary: { type: "text", label: "Summary" },
      acceptedAt: { type: "datetime", label: "Accepted at", readOnly: true },
      signedOffAt: { type: "datetime", label: "Signed off at", readOnly: true },
      invoicedAt: { type: "date", label: "Invoiced on", readOnly: true },
    },
    stages: {
      field: "step",
      stage: { type: "type", order: "position", requiredFields: "needs" },
      requiredByType: { won: ["invoicedAt"] },
    },
  },
} as const;

function fixture(patch: (job: Record<string, unknown>) => Record<string, unknown> = (j) => j) {
  return manifest(ext, {
    objects: {
      step: structuredClone(OBJECTS.step),
      job: patch(structuredClone(OBJECTS.job) as Record<string, unknown>),
    },
  } as never);
}

interface Rec {
  id: string;
  values: Record<string, unknown>;
}

let admin: ActingUser;
let member: ActingUser;
const steps: Record<string, string> = {};

const human = () => context(member);
const mcp = () =>
  context(member, {
    actor: "mcp",
    origin: {
      surface: "mcp",
      clientId: "client-1",
      clientName: "Test client",
      sessionId: unique(),
    },
    reason: "Test reason",
  });

function createJob(values: Record<string, unknown> = {}) {
  return invokeByName(
    "record.create",
    { object: JOB, values: { name: unique("Job"), ...values } },
    human(),
  ) as Promise<Rec>;
}

function update(id: string, values: Record<string, unknown>, ctx = human()) {
  return invokeByName("record.update", { object: JOB, id, values }, ctx) as Promise<Rec>;
}

async function stepOf(id: string) {
  return ((await invokeByName("record.get", { object: JOB, id }, human())) as Rec).values.step;
}

async function historyOf(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT position_id, entered_as FROM core_transition_history WHERE object_type = ? AND record_id = ? ORDER BY entered_at, left_at IS NULL",
  )
    .bind(JOB, id)
    .all<{ position_id: string; entered_as: string }>();
  return results.map((r) => [r.position_id, r.entered_as]);
}

async function refusal(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string; details?: Record<string, unknown> } | null;
  expect(error, "the write should be refused").not.toBeNull();
  return { code: error?.code, message: error?.message, details: error?.details };
}

/** Platform code recording a fact (a quote's acceptance, a sign-off), as stage 35's act will. */
const recordFact = defineOperation({
  name: "fixture.recordJobFact",
  description: "Test fixture: sets a job's host facts, and optionally its stage, as the host.",
  input: z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, JOB, input.id, input.values);
    return { id: input.id };
  },
});

const asHost = (id: string, values: Record<string, unknown>) =>
  invokeOperation(
    recordFact,
    { id, values },
    context(admin, { actor: "automation", origin: { surface: "system", automationId: "fixture" } }),
  );

const ACCEPTED_REFUSAL = () => ({
  code: "invalid_input",
  message: "Accepted needs Accepted at; Accepted at is set by the act it records, not by a move",
  details: {
    rule: "stage_required_fields",
    object: JOB,
    field: "acceptedAt",
    fields: ["acceptedAt"],
    labels: ["Accepted at"],
    stage: { id: steps.accepted, title: "Accepted", type: "open" },
    setByHost: ["acceptedAt"],
  },
});

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(fixture());
  const step = async (
    key: string,
    name: string,
    position: number,
    type: string,
    needs: string[],
  ) => {
    steps[key] = (
      (await invokeByName(
        "record.create",
        { object: STEP, values: { name, position, type, needs } },
        context(admin),
      )) as Rec
    ).id;
  };
  await step("enquiry", "Enquiry", 1, "open", []);
  await step("accepted", "Accepted", 2, "open", ["acceptedAt"]);
  await step("signedOff", "Signed off", 3, "open", ["signedOffAt", "summary"]);
  await step("paid", "Paid", 4, "won", []);
});

beforeEach(async () => {
  await setPreset("autonomous");
});

describe("a stage rule on a host fact in the contract checks", () => {
  const issues = (patch: Parameters<typeof fixture>[0]) =>
    validateManifest(fixture(patch)).issues.map((issue) => `${issue.path}: ${issue.message}`);

  it("accepts read-only fields in a stage's required fields and in requiredByType", () => {
    expect(validateManifest(fixture()).issues).toEqual([]);
  });

  it("still refuses a formula, the stage field and a field the object does not have", () => {
    expect(
      issues((job) => ({
        ...job,
        fields: {
          ...(job.fields as object),
          total: { type: "formula", label: "Total", expression: "1" },
        },
        stages: {
          ...(job.stages as object),
          requiredByType: { won: ["total", "step", "gone"] },
        },
      })),
    ).toEqual([
      'objects.job.stages.requiredByType.won: "total" must be a field of job other than a formula or the stage field',
      'objects.job.stages.requiredByType.won: "step" must be a field of job other than a formula or the stage field',
      'objects.job.stages.requiredByType.won: "gone" must be a field of job other than a formula or the stage field',
    ]);
  });

  it("refuses a field the stage behaviour keeps itself", () => {
    expect(
      issues((job) => ({
        ...job,
        fields: {
          ...(job.fields as object),
          status: {
            type: "select",
            label: "Status",
            readOnly: true,
            options: [
              { value: "open", label: "Open" },
              { value: "won", label: "Won" },
              { value: "lost", label: "Lost" },
            ],
          },
          closedAt: { type: "date", label: "Closed", readOnly: true },
        },
        stages: {
          ...(job.stages as object),
          status: "status",
          closedDate: "closedAt",
          requiredByType: { open: ["closedAt"], won: ["status", "invoicedAt"] },
        },
      })),
    ).toEqual([
      'objects.job.stages.requiredByType.open: "closedAt" is kept by the stage behaviour itself and cannot be required',
      'objects.job.stages.requiredByType.won: "status" is kept by the stage behaviour itself and cannot be required',
    ]);
  });
});

describe("entering a stage that needs a host fact", () => {
  it("is refused to a person, naming the missing fact, and nothing changes", async () => {
    const job = await createJob();
    expect(job.values.step).toBe(steps.enquiry);
    for (const ctx of [human(), context(admin)]) {
      expect(await refusal(update(job.id, { step: steps.accepted }, ctx))).toEqual(
        ACCEPTED_REFUSAL(),
      );
    }
    // Nor can a person supply the fact.
    expect(
      (
        await refusal(
          update(job.id, { step: steps.accepted, acceptedAt: new Date().toISOString() }),
        )
      ).message,
    ).toMatch(/is set automatically and cannot be written/);
    // Nor create a job already in the stage.
    expect(await refusal(createJob({ step: steps.accepted }))).toMatchObject({
      details: { rule: "stage_required_fields", field: "acceptedAt", setByHost: ["acceptedAt"] },
    });
    expect(await stepOf(job.id)).toBe(steps.enquiry);
    expect(await historyOf(job.id)).toEqual([[steps.enquiry, "staff"]]);
  });

  it("names the host fact first when a writable field is missing too", async () => {
    const job = await createJob();
    expect(await refusal(update(job.id, { step: steps.signedOff }))).toEqual({
      code: "invalid_input",
      message:
        "Signed off needs Signed off at, Summary; Signed off at is set by the act it records, not by a move",
      details: {
        rule: "stage_required_fields",
        object: JOB,
        field: "signedOffAt",
        fields: ["signedOffAt", "summary"],
        labels: ["Signed off at", "Summary"],
        stage: { id: steps.signedOff, title: "Signed off", type: "open" },
        setByHost: ["signedOffAt"],
      },
    });
    // Filling the writable field is not enough.
    expect(
      await refusal(update(job.id, { step: steps.signedOff, summary: "Wired the kitchen" })),
    ).toMatchObject({ details: { fields: ["signedOffAt"], setByHost: ["signedOffAt"] } });
  });

  it("holds requiredByType on a host fact for a won stage", async () => {
    const job = await createJob();
    expect(await refusal(update(job.id, { step: steps.paid }))).toMatchObject({
      message: "Paid needs Invoiced on; Invoiced on is set by the act it records, not by a move",
      details: { field: "invoicedAt", setByHost: ["invoicedAt"] },
    });
  });

  it("is refused to an MCP client, applied directly or through the approval queue", async () => {
    const job = await createJob();
    expect(await refusal(update(job.id, { step: steps.accepted }, mcp()))).toEqual(
      ACCEPTED_REFUSAL(),
    );
    await setPreset("cautious");
    expect(await refusal(update(job.id, { step: steps.accepted }, mcp()))).toEqual(
      ACCEPTED_REFUSAL(),
    );
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action WHERE input LIKE ?",
    )
      .bind(`%${job.id}%`)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
    expect(await stepOf(job.id)).toBe(steps.enquiry);
  });

  it("lets the extension's own code set the fact only from a tool a person calls", async () => {
    // A fact is written like a holder's terms (ADR 0513): by the host, or by the declaring
    // extension's tool that only a person may call or approve, never its other code.
    const job = await createJob();
    const principal = { ...member, id: `extension:${ext}` };
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at, kind, role) VALUES (?, ?, ?, 0, ?, ?, 'extension', 'member')",
    )
      .bind(principal.id, ext, `${ext}@extensions.crm.invalid`, now, now)
      .run();
    const asExtension = (tool?: { humanOnly: boolean; personApproves?: boolean }) =>
      context(principal, {
        actor: "extension",
        origin: { surface: "extension", extensionId: ext },
        extension: {
          id: ext,
          permissions: { read: [], write: [], operations: [], modules: ["ops"] },
          ...(tool
            ? { tool: { name: "recordAcceptance", permission: `${ext}:manage`, ...tool } }
            : {}),
        },
      });
    expect(await refusal(update(job.id, { step: steps.accepted }, asExtension()))).toEqual(
      ACCEPTED_REFUSAL(),
    );
    // An automation, or a tool an AI may call: refused, alone or with the move.
    for (const ctx of [asExtension(), asExtension({ humanOnly: false })]) {
      for (const values of [{ acceptedAt: now }, { step: steps.accepted, acceptedAt: now }]) {
        expect((await refusal(update(job.id, values, ctx))).message).toMatch(
          /acceptedAt is set automatically and cannot be written/,
        );
      }
    }
    expect(await stepOf(job.id)).toBe(steps.enquiry);
    // A person's own act records it and moves the job together.
    await update(
      job.id,
      { step: steps.accepted, acceptedAt: now },
      asExtension({ humanOnly: true }),
    );
    expect(await stepOf(job.id)).toBe(steps.accepted);
  });

  it("is refused to an import", async () => {
    const name = unique("Imported");
    const csv = `Name,Step\n${name} A,${steps.enquiry}\n${name} B,${steps.accepted}\n`;
    expect(
      await refusal(invokeByName("import.records.commit", { object: JOB, csv }, context(admin))),
    ).toEqual({
      code: "invalid_input",
      message: `Row 2: ${ACCEPTED_REFUSAL().message}`,
      details: { row: 2, ...ACCEPTED_REFUSAL().details },
    });
    const out = (await invokeByName(
      "import.records.commit",
      { object: JOB, csv, skipInvalid: true },
      context(admin),
    )) as { created: string[]; skipped: { row: number; errors: string[] }[] };
    expect(out.created).toHaveLength(1);
    expect(out.skipped).toEqual([{ row: 2, errors: [ACCEPTED_REFUSAL().message] }]);
  });

  it("is open to staff once the host has set the fact, and the fact cannot then be emptied", async () => {
    const job = await createJob();
    await asHost(job.id, { acceptedAt: "2026-11-24T09:00:00.000Z" });
    expect(await stepOf(job.id)).toBe(steps.enquiry);
    await update(job.id, { step: steps.accepted });
    expect(await historyOf(job.id)).toEqual([
      [steps.enquiry, "staff"],
      [steps.accepted, "staff"],
    ]);
    // In the stage, even the host cannot empty the fact it requires.
    expect(await refusal(asHost(job.id, { acceptedAt: null }))).toMatchObject({
      details: { rule: "stage_required_fields", field: "acceptedAt", setByHost: ["acceptedAt"] },
    });
  });

  it("is made by platform code that sets the fact in the act's own write", async () => {
    const job = await createJob({ summary: "Rewired the kitchen" });
    // The host is held to the rule too.
    expect(await refusal(asHost(job.id, { step: steps.accepted }))).toMatchObject({
      details: { rule: "stage_required_fields", field: "acceptedAt" },
    });
    await asHost(job.id, { acceptedAt: "2026-11-24T09:00:00.000Z", step: steps.accepted });
    await asHost(job.id, { signedOffAt: "2026-11-25T15:00:00.000Z", step: steps.signedOff });
    expect(await historyOf(job.id)).toEqual([
      [steps.enquiry, "staff"],
      [steps.accepted, "host"],
      [steps.signedOff, "host"],
    ]);
  });
});

describe("the stages a host fact gates", () => {
  const editStep = (id: string, values: Record<string, unknown>, ctx = human()) =>
    invokeByName("record.update", { object: STEP, id, values }, ctx);
  const ADMIN_ONLY = {
    code: "forbidden",
    message:
      "Steps decide when a record waits on what the platform records, so only an admin changes them, in person",
    details: {
      rule: "stage_settings_admin_only",
      object: STEP,
      gates: [{ object: JOB, facts: ["acceptedAt", "signedOffAt", "invoicedAt"] }],
    },
  };

  it("cannot be loosened by a member or an AI client, so the move stays refused", async () => {
    const job = await createJob();
    // The review's two sequences: drop the fact from Accepted, or turn Paid into an open stage.
    for (const ctx of [human(), mcp()]) {
      expect(await refusal(editStep(steps.accepted as string, { needs: [] }, ctx))).toEqual(
        ADMIN_ONLY,
      );
      expect(await refusal(editStep(steps.paid as string, { type: "open" }, ctx))).toEqual(
        ADMIN_ONLY,
      );
    }
    expect(await refusal(update(job.id, { step: steps.accepted }, mcp()))).toEqual(
      ACCEPTED_REFUSAL(),
    );
    expect(await refusal(update(job.id, { step: steps.paid }))).toMatchObject({
      details: { field: "invoicedAt" },
    });
    expect(await stepOf(job.id)).toBe(steps.enquiry);
  });

  it("cannot gain a stage of a member's or an AI's making, nor lose or regain one", async () => {
    for (const ctx of [human(), mcp()]) {
      expect(
        await refusal(
          invokeByName(
            "record.create",
            { object: STEP, values: { name: "Accepted", position: 2, type: "open" } },
            ctx,
          ),
        ),
      ).toEqual(ADMIN_ONLY);
      expect(
        await refusal(invokeByName("record.delete", { object: STEP, id: steps.enquiry }, ctx)),
      ).toEqual(ADMIN_ONLY);
    }
    const name = unique("Step");
    expect(
      await refusal(
        invokeByName(
          "import.records.commit",
          { object: STEP, csv: `Name,Position,Type\n${name},9,open\n` },
          human(),
        ),
      ),
    ).toMatchObject({ details: { row: 1, rule: "stage_settings_admin_only" } });
  });

  it("are an admin's to change, in person", async () => {
    const extra = (await invokeByName(
      "record.create",
      { object: STEP, values: { name: unique("Review"), position: 5, type: "open" } },
      context(admin),
    )) as Rec;
    // An AI client acting for the admin is still refused.
    const adminMcp = context(admin, {
      actor: "mcp",
      origin: {
        surface: "mcp",
        clientId: "client-1",
        clientName: "Test client",
        sessionId: unique(),
      },
      reason: "Test reason",
    });
    expect(await refusal(editStep(extra.id, { position: 6 }, adminMcp))).toEqual(ADMIN_ONLY);
    await editStep(extra.id, { position: 6 }, context(admin));
    await invokeByName("record.delete", { object: STEP, id: extra.id }, context(admin));
    expect(
      await refusal(invokeByName("record.restore", { object: STEP, id: extra.id }, human())),
    ).toEqual(ADMIN_ONLY);
    await invokeByName("record.restore", { object: STEP, id: extra.id }, context(admin));
  });
});
