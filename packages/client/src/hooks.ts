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
//
// A hook that reads what each audience reads its own way (a customer's `my.list`, staff's
// `record.list`) names the alternatives, `{ anyOf: [["record.list"], ["my.list"]] }`: it is there
// for a client holding all of one of them, and asks `holds` which it has (the first held wins).
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

/**
 * What one hook calls: every operation of a list, or every operation of one of several lists
 * (`anyOf`, the first one the client holds), for a read each audience makes its own way.
 */
export type HookCalls<N extends string = string> =
  | readonly N[]
  | { readonly anyOf: readonly (readonly N[])[] };

/** Every operation a hook may call, whichever of its alternatives a client holds. */
export function hookOperations(calls: HookCalls): string[] {
  return "anyOf" in calls ? [...new Set(calls.anyOf.flat())] : [...calls];
}

/** Every operation any of the hooks may call: what a client holding them all holds. */
export function hooksOperations(calls: Readonly<Record<string, HookCalls>>): string[] {
  return [...new Set(Object.values(calls).flatMap(hookOperations))];
}

/** Whether a client holding `Names` backs `C`: all of a list, or all of one list of `anyOf`. */
type Backed<C, Names extends string> = C extends { readonly anyOf: readonly (infer L)[] }
  ? L extends readonly string[]
    ? L[number] extends Names
      ? true
      : never
    : never
  : C extends readonly string[]
    ? C[number] extends Names
      ? true
      : never
    : never;

/** The hooks of `H` a client holding `Names` can back: those all of whose operations it holds. */
export type HooksFor<
  H,
  Calls extends { readonly [K in keyof H]: HookCalls },
  Names extends string,
> = {
  [K in keyof H as [Backed<Calls[K], Names>] extends [never] ? never : K]: H[K];
};

/**
 * The hooks `make` writes, keeping only those whose operations (`calls`, one list per hook, an
 * empty list for a hook that calls none) the client holds: in the type and at run time.
 *
 * `make` is given the client typed over all the pack's operations, and `holds`, which says
 * whether the client holds an operation (for a hook with `anyOf`); a hook it writes over an
 * operation the client lacks is never returned, so it is never called.
 */
export function packHooks<
  T extends OperationTypes,
  H extends object,
  const Calls extends { readonly [K in keyof H]: HookCalls<keyof T & string> },
  C extends ClientHolding,
>(
  api: C,
  calls: Calls,
  make: (api: PackClient<T>, holds: (operation: keyof T & string) => boolean) => H,
): HooksFor<H, Calls, OperationsOf<C>> {
  const held = new Set(Object.keys(api.operations));
  const holds = (operation: string) => held.has(operation);
  // The one place the client is used as the client of every operation: only the hooks whose
  // operations it holds leave this function.
  const hooks = make(api as unknown as PackClient<T>, holds);
  const out: Record<string, unknown> = {};
  for (const [name, hook] of Object.entries(hooks)) {
    const needs = (calls as Record<string, HookCalls | undefined>)[name];
    if (!needs) throw new Error(`packHooks: ${name} does not say which operations it calls`);
    const lists = "anyOf" in needs ? needs.anyOf : [needs];
    if (lists.some((list) => list.every(holds))) out[name] = hook;
  }
  return out as HooksFor<H, Calls, OperationsOf<C>>;
}
