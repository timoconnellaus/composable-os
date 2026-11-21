// The core registry and typed entry points adapters call.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { allowsAudience, audiencesOf } from "./audiences.ts";
import { UnknownOperationError } from "./errors.ts";
import { loadExtensionOperations, resolveExtensionOperation } from "./extensions/tools.ts";
import type { AnyOperation, OperationInput, OperationOutput } from "./operation.ts";
import { coreOperations } from "./operations/index.ts";
import { type AnyInvocationContext, invokeOperation } from "./pipeline.ts";
import { staffPrincipal } from "./principals.ts";
import { createRegistry, type OperationMap, type OperationRegistry } from "./registry.ts";

export const coreRegistry = createRegistry(coreOperations);

/** `{ "person.create": typeof personCreate, ... }` */
export type CoreOperations = OperationMap<typeof coreOperations>;
export type CoreOperationName = keyof CoreOperations & string;
export type CoreInput<N extends CoreOperationName> = OperationInput<CoreOperations[N]>;
export type CoreOutput<N extends CoreOperationName> = OperationOutput<CoreOperations[N]>;

/** A typed `invoke` and a name-checked `invokeByName` over any registry. */
export function createInvoker<Ops extends readonly AnyOperation[]>(
  registry: OperationRegistry<Ops>,
) {
  type Map = OperationMap<Ops>;
  /** For adapters receiving a name from the wire: rejects with UnknownOperationError. */
  const invokeByName = async (
    name: string,
    input: unknown,
    ctx: AnyInvocationContext,
  ): Promise<unknown> => {
    // Extension tools (`x.<extension>.<tool>`) are resolved from installed manifests.
    const op = registry.get(name) ?? (await resolveExtensionOperation(ctx.db.query, name));
    if (!op) throw new UnknownOperationError(name);
    // A customer's or the public's call (ADR 0402) runs no other operation and resolves none.
    if (ctx.principal) return invokeOperation(op, input, ctx);
    // Approvals re-run queued actions by name, synchronously; queued extension tools must
    // resolve too, so load them first.
    const extensionOps =
      name.startsWith("approval.") || name === "extension.approve" || name === "agent.start"
        ? new Map((await loadExtensionOperations(ctx.db.query)).map((o) => [o.name, o]))
        : null;
    return invokeOperation(op, input, {
      resolveOperation: (other: string) => registry.get(other) ?? extensionOps?.get(other),
      ...ctx,
    });
  };
  const invoke = <N extends keyof Map & string>(
    name: N,
    input: Map[N] extends AnyOperation ? OperationInput<Map[N]> : never,
    ctx: AnyInvocationContext,
  ) =>
    invokeByName(name, input, ctx) as Promise<
      Map[N] extends AnyOperation ? OperationOutput<Map[N]> : never
    >;
  /**
   * The operation `name` as this caller may call it directly, or UnknownOperationError: the same
   * answer for a name not registered and one not open to the caller (ADR 0411). For adapters
   * that must know an operation's risk class before invoking it (the HTTP surface's idempotency
   * keys). `invokeByName` checks again in the pipeline.
   */
  const resolveFor = async (name: string, ctx: AnyInvocationContext): Promise<AnyOperation> => {
    const op = registry.get(name) ?? (await resolveExtensionOperation(ctx.db.query, name));
    if (!op || !callableBy(op, ctx)) throw new UnknownOperationError(name);
    return op;
  };
  /** Every operation this caller may call directly: the registry and installed extension tools. */
  const listFor = async (ctx: AnyInvocationContext): Promise<AnyOperation[]> =>
    [...registry.list(), ...(await loadExtensionOperations(ctx.db.query))].filter((op) =>
      callableBy(op, ctx),
    );
  return { invoke, invokeByName, resolveFor, listFor };
}

/** Whether the caller's audience may call `op` directly (a `toolOnly` one only from a tool). */
function callableBy(op: AnyOperation, ctx: AnyInvocationContext): boolean {
  if (ctx.principal) return allowsAudience(op, ctx.principal) && !(op.toolOnly && !ctx.tool);
  return allowsAudience(op, staffPrincipal(ctx.user));
}

export type Invoker = ReturnType<typeof createInvoker>;

const coreInvoker = createInvoker(coreRegistry);

/** Invokes a core operation by name: audience → validate → role → gate → handler → audit. */
export function invoke<N extends CoreOperationName>(
  name: N,
  input: CoreInput<N>,
  ctx: AnyInvocationContext,
): Promise<CoreOutput<N>> {
  return coreInvoker.invokeByName(name, input, ctx) as Promise<CoreOutput<N>>;
}

/** Invokes a core operation whose name arrived as a string. */
export function invokeByName(
  name: string,
  input: unknown,
  ctx: AnyInvocationContext,
): Promise<unknown> {
  return coreInvoker.invokeByName(name, input, ctx);
}

/** The core registry's invoker, with its caller-aware lookup and listing (the HTTP surface). */
export { coreInvoker };

/**
 * Every operation a caller can invoke: the core registry plus installed extension tools. MCP
 * (stage 2) lists tools from this.
 */
export async function listOperations(db: Kysely<CoreDatabase>): Promise<AnyOperation[]> {
  // Staff surfaces list only what staff may call (ADR 0402): an operation for customers alone
  // would answer them as an unknown name.
  return [...coreRegistry.list(), ...(await loadExtensionOperations(db))].filter((op) =>
    audiencesOf(op).includes("staff"),
  );
}
