// Stage 22 step 2 (ADR 0402, ADR 0411): every operation declares its audiences, staff only by
// default; invoke() refuses a caller whose audience is not listed before it looks at the input,
// with the answer an unknown operation gets; and nothing above a write can be opened.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type AnyOperation,
  AUDIENCES,
  audiencesOf,
  coreOperations,
  createInvoker,
  createRegistry,
  defineOperation,
  invokeByName,
  operationProblems,
  RISK_CLASSES,
  UnknownOperationError,
} from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;
let handled = 0;

const base = {
  description: "A fixture operation for the audience tests.",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:read",
  risk: "read",
  handler: async () => {
    handled += 1;
    return { ok: true };
  },
} as const;

const customerOnly = defineOperation({ ...base, name: "fixture.mine", audiences: ["customer"] });
const publicOnly = defineOperation({ ...base, name: "fixture.anyone", audiences: ["public"] });
const shared = defineOperation({
  ...base,
  name: "fixture.shared",
  audiences: ["staff", "customer"],
});
const unmarked = defineOperation({ ...base, name: "fixture.unmarked" });
const registry = createRegistry([customerOnly, publicOnly, shared, unmarked]);
const { invokeByName: invokeFixture } = createInvoker(registry);

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  admin = await createUser("admin");
});

describe("audiences on operations", () => {
  it("an operation that declares none is staff only", () => {
    expect(audiencesOf(unmarked)).toEqual(["staff"]);
    expect(unmarked.audiences).toBeUndefined();
  });

  it("every core operation is staff only: nothing is open yet", () => {
    const open = coreOperations.filter((op) => audiencesOf(op).some((a) => a !== "staff"));
    expect(open.map((op) => op.name)).toEqual([]);
    for (const op of coreOperations) expect(audiencesOf(op)).toContain("staff");
  });

  it("refuses an empty list, an unknown audience and a repeated one", () => {
    const problems = (audiences: unknown) =>
      operationProblems({ ...unmarked, audiences } as unknown as AnyOperation);
    expect(problems([])).toEqual(["audiences must list at least one of staff, customer, public"]);
    expect(problems(["admin"])).toEqual(["audiences must be a subset of staff, customer, public"]);
    expect(problems(["staff", "staff"])).toEqual(["audiences lists one twice"]);
    for (const audience of AUDIENCES) expect(problems([audience])).toEqual([]);
    expect(() => defineOperation({ ...base, name: "fixture.none", audiences: [] })).toThrow(
      /audiences must list at least one/,
    );
  });
});

describe("the risk floor (criterion 8)", () => {
  const above = RISK_CLASSES.filter((risk) => risk !== "read" && risk !== "write");

  it("covers every class above a write", () => {
    expect(above).toEqual(["bulk-write", "destructive", "schema", "extension", "outbound"]);
  });

  for (const audience of ["customer", "public"] as const) {
    for (const risk of above) {
      it(`an operation open to ${audience} with risk ${risk} does not load`, () => {
        const definition = {
          ...base,
          name: "fixture.tooRisky",
          risk,
          audiences: ["staff", audience],
          bulkSize: () => 1,
        } as const;
        expect(() => defineOperation(definition)).toThrow(
          `an operation open to ${audience} callers must have risk class read or write, not ${risk}`,
        );
        // The registry checks again, for a definition built without defineOperation.
        expect(() => createRegistry([definition as unknown as AnyOperation])).toThrow(
          /must have risk class read or write/,
        );
      });
    }
    it(`read and write operations open to ${audience} load`, () => {
      for (const risk of ["read", "write"] as const) {
        expect(
          defineOperation({ ...base, name: "fixture.fine", risk, audiences: [audience] }).risk,
        ).toBe(risk);
      }
    });
  }

  it("the same risk classes are fine for staff", () => {
    for (const risk of above) {
      expect(
        operationProblems({ ...unmarked, risk, bulkSize: () => 1 } as unknown as AnyOperation),
      ).toEqual([]);
    }
  });

  it("an operation open outside the org can never be one that always waits for review", () => {
    expect(() =>
      defineOperation({
        ...base,
        name: "fixture.reviewed",
        audiences: ["customer"],
        alwaysReview: true,
      }),
    ).toThrow(/never queued for review/);
  });
});

describe("invoke() refuses a caller whose audience is not listed", () => {
  it("staff calling an operation for customers or the public get the unknown-operation answer", async () => {
    for (const name of ["fixture.mine", "fixture.anyone"]) {
      const closed = await refusal(() => invokeFixture(name, { id: "x" }, context(admin)));
      const unknown = await refusal(() =>
        invokeFixture("fixture.nothing", { id: "x" }, context(admin)),
      );
      expect(closed).toBeInstanceOf(UnknownOperationError);
      expect(unknown).toBeInstanceOf(UnknownOperationError);
      const shape = (error: unknown, called: string) => {
        const e = error as UnknownOperationError;
        return { ...e.toJSON(), message: e.message.replace(called, "<name>"), name: e.name };
      };
      // One error: the same code, the same words and nothing else, whether or not it exists.
      expect(shape(closed, name)).toEqual(shape(unknown, "fixture.nothing"));
    }
  });

  it("refuses before validation, runs nothing and writes nothing", async () => {
    handled = 0;
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_audit").first<{
      n: number;
    }>();
    const error = await refusal(() =>
      invokeFixture(
        "fixture.mine",
        { id: 42, extra: "not valid" },
        context(admin, { actor: "mcp" }),
      ),
    );
    // Invalid input would be `invalid_input` if validation had run first.
    expect((error as UnknownOperationError).code).toBe("unknown_operation");
    expect(handled).toBe(0);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_audit").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });

  it("staff call what lists staff, marked or not", async () => {
    handled = 0;
    expect(await invokeFixture("fixture.shared", { id: "x" }, context(admin))).toEqual({
      ok: true,
    });
    expect(await invokeFixture("fixture.unmarked", { id: "x" }, context(admin))).toEqual({
      ok: true,
    });
    expect(handled).toBe(2);
  });

  it("existing operations are unaffected", async () => {
    const page = (await invokeByName("person.list", { limit: 1 }, context(admin))) as {
      items: unknown[];
    };
    expect(Array.isArray(page.items)).toBe(true);
  });
});
