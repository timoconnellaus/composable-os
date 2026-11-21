// Audiences (ADR 0402, ADR 0411): who may call an operation at all. Every operation declares a
// non-empty subset of `staff`, `customer` and `public`, and one that declares nothing is staff
// only. `invoke()` refuses a caller whose audience is not listed, before it looks at the input.
//
// Opening an operation to customers or the public is a reviewed change: it must be a `read` or a
// `write`, and it appears in packages/core/open-operations.json, which a test keeps equal to the
// registry.
import type { Principal, RiskClass } from "./principals.ts";

export const AUDIENCES = ["staff", "customer", "public"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** What an operation is when it declares no audiences. */
export const DEFAULT_AUDIENCES: readonly Audience[] = Object.freeze(["staff"]);

/**
 * The risk floor: the only risk classes an operation open to customers or the public may have.
 * Set here, in code, and not configurable (ADR 0402).
 */
export const OUTSIDE_RISK_CLASSES: readonly RiskClass[] = Object.freeze(["read", "write"]);

/** The parts of an operation the audience rules read. */
export interface AudienceDeclaration {
  readonly name: string;
  readonly risk: RiskClass;
  readonly audiences?: readonly Audience[] | undefined;
  readonly hostInternal?: boolean | undefined;
  readonly toolOnly?: boolean | undefined;
}

export function audiencesOf(op: Pick<AudienceDeclaration, "audiences">): readonly Audience[] {
  return op.audiences ?? DEFAULT_AUDIENCES;
}

/** Whether anyone but staff may call it. */
export function isOpenOutside(op: Pick<AudienceDeclaration, "audiences">): boolean {
  return audiencesOf(op).some((audience) => audience !== "staff");
}

/** The audience a caller belongs to. A caller has exactly one. */
export function audienceOf(principal: Principal): Audience {
  return principal.kind;
}

export function allowsAudience(
  op: Pick<AudienceDeclaration, "audiences">,
  principal: Principal,
): boolean {
  return audiencesOf(op).includes(audienceOf(principal));
}

/** What is wrong with an operation's audiences (empty when nothing is). */
export function audienceProblems(op: AudienceDeclaration): string[] {
  const problems: string[] = [];
  const declared = op.audiences;
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.length === 0) {
      problems.push("audiences must list at least one of staff, customer, public");
      return problems;
    }
    if (declared.some((a) => !AUDIENCES.includes(a))) {
      problems.push("audiences must be a subset of staff, customer, public");
      return problems;
    }
    if (new Set(declared).size !== declared.length) problems.push("audiences lists one twice");
  }
  if (isOpenOutside(op) && !OUTSIDE_RISK_CLASSES.includes(op.risk)) {
    const who = audiencesOf(op).filter((a) => a !== "staff");
    problems.push(
      `an operation open to ${who.join(" and ")} callers must have risk class read or write, ` +
        `not ${op.risk} (ADR 0402)`,
    );
  }
  return problems;
}

/** One line of the generated list: an operation someone outside the org may call. */
export interface OpenOperation {
  name: string;
  audiences: Audience[];
  risk: RiskClass;
  /** Present and true when the handler keeps the raw database (ADR 0413). */
  hostInternal?: true;
  /** Present and true when customers reach it only from inside a pack's tool (ADR 0414). */
  toolOnly?: true;
  /** The pack whose tool it is (`x.<pack>.<tool>`); absent for a core operation. */
  pack?: string;
}

/** The shape of packages/core/open-operations.json. */
export interface OpenOperationsFile {
  $comment: string;
  operations: OpenOperation[];
}

export const OPEN_OPERATIONS_COMMENT =
  "Generated. Every operation customers or the public may call, with its risk class " +
  "(ADR 0402, ADR 0411). Do not edit: run `pnpm --filter @composable-os/core open-operations`. " +
  "A new line here opens the host to people outside the org, so review it as such.";

/** Every operation in `operations` open to customers or the public, by name. */
export function openOperations(operations: readonly AudienceDeclaration[]): OpenOperationsFile {
  return {
    $comment: OPEN_OPERATIONS_COMMENT,
    operations: operations
      .filter(isOpenOutside)
      .map((op) => ({
        name: op.name,
        audiences: AUDIENCES.filter((a) => audiencesOf(op).includes(a)),
        risk: op.risk,
        ...(op.hostInternal ? { hostInternal: true as const } : {}),
        ...(op.toolOnly ? { toolOnly: true as const } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---- Packs in the release's files -----------------------------------------------------------------
//
// A release carries every pack in the repository, and its committed files (open-operations.json,
// api/v1/<audience>.json) are the union of what a host of that release can serve: the core
// operations, and each carried pack's tools, each of those named with its `pack`. A deployment
// serves the core operations and the tools of the packs it installs (COS_PACKS), so what it serves
// is `forPacks(file, installed)`, exactly (ADR 0420 and ADR 0422, amended 2026-11-21).

/** The pack (or extension) an operation's name says it belongs to: `x.<id>.<tool>`, else none. */
export function packOf(name: string): string | undefined {
  const [first, id] = name.split(".");
  return first === "x" && id ? id : undefined;
}

/**
 * `file` with each operation of a carried pack named with its `pack`. Throws for an `x.*`
 * operation whose extension is not one of `packs`: the release's files name packs only.
 */
export function withPacks<T extends { operations: { name: string }[] }>(
  file: T,
  packs: readonly string[],
): T {
  return {
    ...file,
    operations: file.operations.map((op) => {
      const pack = packOf(op.name);
      if (!pack) return op;
      if (!packs.includes(pack)) {
        throw new Error(`${op.name} is a tool of ${pack}, which is not a pack the release carries`);
      }
      return { ...op, pack };
    }),
  };
}

/**
 * What a deployment that installs `installed` serves of a release's file: the core operations
 * and the installed packs' tools, without the `pack` names (a deployment's manifest has none).
 */
export function forPacks<T extends { operations: { name: string; pack?: string }[] }>(
  file: T,
  installed: readonly string[],
): T {
  return {
    ...file,
    operations: file.operations
      .filter((op) => {
        const pack = op.pack ?? packOf(op.name);
        return pack === undefined || installed.includes(pack);
      })
      .map(({ pack: _pack, ...op }) => op),
  };
}
