// Stage 41: number fields' `min`, `max` and `step`, held by the host for every actor, in the CSV
// import and in the approval queue's dry run.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, PendingApprovalError } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

const EXT = extId("num");
const SET = `${EXT}.set`;
let admin: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(EXT, {
      objects: {
        set: {
          label: "Set",
          plural: "Sets",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            rpe: { type: "number", label: "RPE", min: 1, max: 10, step: 0.5 },
            load: { type: "currency", label: "Load", min: 0, step: 0.25 },
            reps: { type: "number", label: "Reps", min: 0, step: 1 },
          },
        },
      },
    }),
  );
});

describe("number bounds", () => {
  it("takes a value inside them and refuses one outside, naming the bound, for every actor", async () => {
    const ok = await invoke(
      "record.create",
      { object: SET, values: { name: "ok", rpe: 7.5, load: 22.25, reps: 8 } },
      context(admin),
    );
    expect(ok.values).toMatchObject({ rpe: 7.5, load: 22.25, reps: 8 });
    const cases: [Record<string, unknown>, string][] = [
      [{ rpe: 50 }, "rpe: At most 10"],
      [{ rpe: 0.5 }, "rpe: At least 1"],
      [{ rpe: 7.3 }, "rpe: In steps of 0.5 from 1"],
      [{ load: -1 }, "load: At least 0"],
      [{ reps: 2.5 }, "reps: In steps of 1 from 0"],
    ];
    for (const actor of ["human", "assistant", "mcp", "automation"] as const) {
      for (const [values, message] of cases) {
        const error = await refusal(
          invoke(
            "record.update",
            { object: SET, id: ok.id, values },
            context(admin, {
              actor,
              origin: {
                surface: actor === "human" ? "ui" : actor === "mcp" ? "mcp" : actor,
                sessionId: unique("s"),
              },
            } as never),
          ),
        );
        expect(error.message, `${actor} ${JSON.stringify(values)}`).toBe(
          `Invalid value for ${SET}.${Object.keys(values)[0]}: ${message}`,
        );
      }
    }
  });

  it("holds in the CSV import and the approval queue's dry run", async () => {
    const imported = await refusal(
      invoke("import.records.commit", { object: SET, csv: "name,rpe\nx,11\n" }, context(admin)),
    );
    expect(JSON.stringify(imported)).toContain("rpe: At most 10");
    await setPreset("cautious");
    try {
      const mcp = context(admin, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: unique("s") },
      });
      const before = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
        n: number;
      }>();
      const dry = await refusal(
        invoke("record.create", { object: SET, values: { name: "q", rpe: 50 } }, mcp),
      );
      expect(dry.message).toBe(`Invalid value for ${SET}.rpe: rpe: At most 10`);
      const after = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
        n: number;
      }>();
      expect(after?.n).toBe(before?.n);
      expect(
        await refusal(invoke("record.create", { object: SET, values: { name: "q", rpe: 9 } }, mcp)),
      ).toBeInstanceOf(PendingApprovalError);
    } finally {
      await setPreset("balanced");
    }
  });

  it("is checked in the manifest", () => {
    const { issues } = validateManifest(
      manifest(extId("bad"), {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", min: 1 },
              n: { type: "number", label: "N", min: 5, max: 1 },
              d: { type: "number", label: "D", min: 1, max: 10, step: 0.5, default: 1.2 },
            },
          },
        },
      }),
    );
    expect(issues.map((i) => `${i.path.split(".").slice(-2).join(".")}: ${i.message}`)).toEqual(
      expect.arrayContaining([
        "name.min: Only number fields take min",
        "n.min: min is above max",
        "d.default: The default is outside the field's min, max or step",
      ]),
    );
  });
});
