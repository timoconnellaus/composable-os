// The HTTP surface's contract (stage 23, ADR 0403, ADR 0417): what a client may call, per
// audience, with JSON Schema for each operation's input and output. The same description is
// served at GET /api/v<n>/manifest, committed as a golden file per audience
// (packages/core/api/v1/<audience>.json), and read by `cos client generate` to write a product's
// typed client.
import { z } from "zod";
import { AUDIENCES, type Audience, audiencesOf } from "../audiences.ts";
import type { AnyOperation } from "../operation.ts";
import type { RiskClass } from "../principals.ts";

/** The version of the surface this host serves as current. */
export const API_VERSION = "v1";
/**
 * Every version the host serves: the current one and the previous one (ADR 0403). A version
 * before the oldest is answered `upgrade_required`. When v2 ships, v1 stays here until v3.
 */
export const SERVED_API_VERSIONS: readonly string[] = Object.freeze([API_VERSION]);

export type JsonSchema = Record<string, unknown>;

export interface ContractOperation {
  name: string;
  description: string;
  risk: RiskClass;
  audiences: Audience[];
  /** A read is a query; anything else is a mutation, which needs an idempotency key. */
  kind: "query" | "mutation";
  input: JsonSchema;
  output: JsonSchema;
  /** For a mutation: the operations whose query results it makes stale. */
  invalidates: string[];
  /** Input keys only staff may pass: dropped from every other audience's contract. */
  staffInput?: string[];
  /**
   * In a release's committed files only: the pack whose tool it is (`withPacks`). A deployment's
   * own manifest names none: it serves the packs it installed (`forPacks`).
   */
  pack?: string;
}

export interface ApiContract {
  version: string;
  operations: ContractOperation[];
}

/**
 * A release's pack roles (ADR 0436), committed as `api/<version>/roles.json` beside the contract
 * and carried in the client kit: for each, the staff operations a holder may call. `cos client
 * generate` writes a role's own client from it (ADR 0451).
 */
export interface PackRolesFile {
  version: string;
  roles: {
    /** `<pack>.<role>`, as an account holds it. */
    name: string;
    pack: string;
    label: string;
    description: string;
    /** The objects whose records the role reads (record.get and record.list take only these). */
    read: string[];
    /** Every operation a holder may call: its tools and the generic reads. */
    operations: string[];
  }[];
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    const out = z.toJSONSchema(schema, { unrepresentable: "any", io }) as JsonSchema;
    const { $schema: _drop, ...rest } = out;
    return rest;
  } catch {
    return {};
  }
}

/**
 * What a write makes stale, from what it writes: its namespace (`person.update` writes people,
 * `x.deals.win` writes the Deals extension's records; `recurring.*` writes records). A customer's own records are one
 * namespace, `me.*` and `my.*` together, and a pack's tool writes them too.
 */
function staleGroup(name: string): string {
  const [first, second] = name.split(".");
  if (first === "me" || first === "my") return "self";
  // A recurring schedule's operations write records (a series' classes, their exceptions), and
  // record.update sets and clears the exceptions recurring.exceptions reads (ADR 0620).
  if (first === "recurring") return "record";
  if (first === "x") return `x.${second}`;
  return first ?? name;
}

/** Operations a client can call: tool-only ones (reached only from inside a tool) are left out. */
export function buildContract(operations: readonly AnyOperation[]): ApiContract {
  const callable = operations.filter((op) => !op.toolOnly);
  const queries = callable.filter((op) => op.risk === "read");
  const entries = callable.map((op): ContractOperation => {
    const kind = op.risk === "read" ? "query" : "mutation";
    const group = staleGroup(op.name);
    const reaches = (q: AnyOperation) =>
      staleGroup(q.name) === group || (group.startsWith("x.") && staleGroup(q.name) === "self");
    return {
      name: op.name,
      description: op.description,
      risk: op.risk,
      audiences: AUDIENCES.filter((a) => audiencesOf(op).includes(a)),
      kind,
      input: jsonSchema(op.input, "input"),
      output: jsonSchema(op.output, "output"),
      ...(op.staffInput?.length ? { staffInput: [...op.staffInput] } : {}),
      invalidates:
        kind === "mutation"
          ? queries
              .filter(reaches)
              .map((q) => q.name)
              .sort()
          : [],
    };
  });
  return {
    version: API_VERSION,
    operations: entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** The contract as one audience sees it: only what they may call, nothing else named. */
/** An object schema without the properties `keys` names (and not requiring them). */
function withoutKeys(schema: JsonSchema, keys: readonly string[]): JsonSchema {
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const key of keys) delete properties[key];
  const required = ((schema.required as string[] | undefined) ?? []).filter(
    (k) => !keys.includes(k),
  );
  return { ...schema, properties, ...(schema.required ? { required } : {}) };
}

export function contractFor(contract: ApiContract, audience: Audience): ApiContract {
  const mine = contract.operations.filter((op) => op.audiences.includes(audience));
  const names = new Set(mine.map((op) => op.name));
  return {
    version: contract.version,
    operations: mine.map(({ staffInput, ...op }) => ({
      ...op,
      audiences: [audience],
      input: audience === "staff" || !staffInput ? op.input : withoutKeys(op.input, staffInput),
      invalidates: op.invalidates.filter((n) => names.has(n)),
    })),
  };
}

/**
 * What would break a client compiled against `before`: an operation gone or changed in kind or
 * risk, an input property now required or gone, an output property gone. Additions are not
 * breaking. Used to say why the golden file check failed (ADR 0417).
 */
export function breakingChanges(before: ApiContract, after: ApiContract): string[] {
  const now = new Map(after.operations.map((op) => [op.name, op]));
  const problems: string[] = [];
  const props = (s: JsonSchema) => Object.keys((s.properties as JsonSchema | undefined) ?? {});
  const required = (s: JsonSchema) => (s.required as string[] | undefined) ?? [];
  for (const old of before.operations) {
    const op = now.get(old.name);
    if (!op) {
      problems.push(`${old.name} was removed`);
      continue;
    }
    if (op.kind !== old.kind) problems.push(`${old.name} is now a ${op.kind}`);
    for (const p of required(op.input)) {
      if (!required(old.input).includes(p)) problems.push(`${old.name} now requires input ${p}`);
    }
    for (const p of props(old.input)) {
      if (!props(op.input).includes(p)) problems.push(`${old.name} no longer takes input ${p}`);
    }
    for (const p of props(old.output)) {
      if (!props(op.output).includes(p)) problems.push(`${old.name} no longer returns ${p}`);
    }
  }
  return problems;
}
