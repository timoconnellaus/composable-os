import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import type { Layout } from "../../../packs/programs/layout.ts";
import { db, host, newCustomer } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files = packFiles("programs");

/** The extension host of a deployment whose product lists Programs. */
export const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [...(await host.shipped()), { id: "programs", version: "0.1.0" }],
  commitShipped: (id) =>
    id === "programs"
      ? host.commit({
          id,
          files,
          message: "Shipped programs 0.1.0",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

export const EXERCISE = "programs.exercise";
export const PROGRAM = "programs.program";
export const CLASSTYPE = "programs.classtype";
export const ASSIGNMENT = "programs.assignment";
export const SESSION = "programs.session";
export const LOG = "programs.log";

export const staff = (
  user: ActingUser,
  extra: Partial<InvocationContext> = {},
): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});

export const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});

export function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code, message and the inner code of a tool's refusal. */
export async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, message: e.message, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

export async function installPrograms(admin: ActingUser): Promise<void> {
  await run("extension.install", { id: "programs", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
}

export async function create(
  admin: ActingUser,
  object: string,
  values: Record<string, unknown>,
): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
}

export async function createCustomer(
  admin: ActingUser,
  label: string,
  name = `Given-${label}`,
): Promise<CustomerPrincipal> {
  return (await newCustomer(staff(admin), label, { givenName: name })).principal;
}

/** Two weeks, a session on Monday (a row, a pike with levels) and one on Thursday. */
export function twoWeeks(bank: { pike: string; row: string }): Layout {
  return {
    weeks: Array.from({ length: 2 }, (_, w) => ({
      sessions: [
        {
          name: `Press ${w + 1}`,
          day: 1,
          blocks: [
            {
              label: "A",
              items: [
                {
                  kind: "all",
                  label: "A1",
                  exercises: [
                    {
                      exercise: bank.row,
                      sets: [
                        { kind: "reps", reps: 8, load: 20 },
                        { kind: "reps", reps: 8, load: 20 },
                      ],
                    },
                  ],
                },
                {
                  kind: "levels",
                  label: "A2",
                  levels: [
                    {
                      mode: "one",
                      level: 1,
                      exercise: { exercise: bank.pike, sets: [{ kind: "reps", reps: 5 }] },
                    },
                    {
                      mode: "one",
                      level: 3,
                      exercise: { exercise: bank.pike, sets: [{ kind: "reps", reps: 8 }] },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: `Pull ${w + 1}`,
          day: 4,
          blocks: [
            {
              label: "A",
              items: [
                {
                  kind: "levels",
                  label: "A1",
                  levels: [
                    {
                      mode: "one",
                      level: 1,
                      exercise: { exercise: bank.pike, sets: [{ kind: "reps", reps: 5 }] },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })),
  };
}
