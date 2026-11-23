// A pack's hooks over a client that holds only some of the pack's operations (ADR 0453): a
// customer's client, a pack role's client (`roles/<pack>.<role>.ts`), the staff client. The hooks a
// client cannot back are not there: absent from the returned object, and absent from its type, so
// calling one is a compile error at the call site, never a runtime surprise.
//
// A pack writes its hooks once, over the client of all its operations, and says which operations
// each hook calls:
//
//   export function createTicketingHooks<C extends ClientHolding>(react, api: C) {
//     return packHooks(api, TICKETING_HOOKS_CALL, (api: PackClient<TicketingOperations>) => ({
//       useCheckIn: () => react.useMutation(api.mutation("x.ticketing.checkIn")),
//       …
//     }));
//   }
//   const TICKETING_HOOKS_CALL = { useCheckIn: ["x.ticketing.checkIn"], … } as const;
//
// and a block takes only the hooks it calls: `ticketing: Pick<TicketingHooks, "useCheckIn">`.
import type { MutationName, OperationTypes, QueryName } from "./client.ts";

/** Any generated client: it says which operations it holds (`operations`, ADR 0453). */
export interface ClientHolding {
  readonly operations: object;
}

/** The names of the operations a client holds. */
export type OperationsOf<C> = C extends { readonly operations: infer O } ? keyof O & string : never;

/**
 * The part of a generated client a pack's hooks use, over the pack's operations `T`: what the
 * hooks are written against. Every generated client that holds them fits it.
 */
export interface PackClient<T extends OperationTypes> {
  /** The host the client talks to (a generated client's `baseUrl`), when it has one. */
  readonly baseUrl?: string;
  query<N extends QueryName<T>>(
    name: N,
    input: T[N]["input"],
  ): { queryKey: readonly unknown[]; queryFn: () => Promise<T[N]["output"]> };
  mutation<N extends MutationName<T>>(
    name: N,
  ): {
    mutationKey: readonly unknown[];
    mutationFn: (input: T[N]["input"]) => Promise<T[N]["output"]>;
  };
}

/** The hooks of `H` a client holding `Names` can back: those all of whose operations it holds. */
export type HooksFor<
  H,
  Calls extends { readonly [K in keyof H]: readonly string[] },
  Names extends string,
> = {
  [K in keyof H as Calls[K][number] extends Names ? K : never]: H[K];
};

/**
 * The hooks `make` writes, keeping only those whose operations (`calls`, one list per hook, an
 * empty list for a hook that calls none) the client holds: in the type and at run time.
 *
 * `make` is given the client typed over all the pack's operations; a hook it writes over an
 * operation the client lacks is never returned, so it is never called.
 */
export function packHooks<
  T extends OperationTypes,
  H extends object,
  const Calls extends { readonly [K in keyof H]: readonly (keyof T & string)[] },
  C extends ClientHolding,
>(api: C, calls: Calls, make: (api: PackClient<T>) => H): HooksFor<H, Calls, OperationsOf<C>> {
  const held = new Set(Object.keys(api.operations));
  // The one place the client is used as the client of every operation: only the hooks whose
  // operations it holds leave this function.
  const hooks = make(api as unknown as PackClient<T>);
  const out: Record<string, unknown> = {};
  for (const [name, hook] of Object.entries(hooks)) {
    const needs = (calls as Record<string, readonly string[] | undefined>)[name];
    if (!needs) throw new Error(`packHooks: ${name} does not say which operations it calls`);
    if (needs.every((op) => held.has(op))) out[name] = hook;
  }
  return out as HooksFor<H, Calls, OperationsOf<C>>;
}
