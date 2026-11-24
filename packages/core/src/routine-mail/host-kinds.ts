// Host kinds (ADR 0670): routine message kinds the host declares itself, asked for by host code
// (subscriptions' payment messages to the payer, stage 30 step 2), never by an automation, a tool,
// the assistant or MCP. They are declared in core code with the same declaration and the same
// contract checks as a pack's, and sent through the same path (`prepareHostRoutineMail`): the
// recipient from the record, the words of the declaration, every value checked by its mark.
//
// Their ids are `core.<name>`: `core` is an extension id no extension can take, so a pack's kind
// never shares one. Each is off until a human admin turns it on (Settings → Routine email).
import {
  ROUTINE_MAIL_MODULE,
  type RoutineMailKindManifest,
  type RoutineMailSpec,
  routineMailIssues,
  routineMailManifestSchema,
} from "@composable-os/sdk";

/** The extension id a host kind's rows and settings carry. */
export const HOST_KINDS_EXTENSION = "core";

const declared = new Map<string, RoutineMailKindManifest>();

/**
 * Declares a host kind, checked as a pack's declaration is; a declaration the contract refuses
 * throws (a mistake in core code, found by its tests). Declaring the same name again replaces it.
 */
export function declareHostRoutineKind(name: string, spec: RoutineMailSpec): void {
  const parsed = routineMailManifestSchema.safeParse({ [name]: spec });
  if (!parsed.success) throw new Error(`Host kind ${name}: ${parsed.error.message}`);
  const kind = parsed.data[name] as RoutineMailKindManifest;
  const issues = routineMailIssues({
    id: HOST_KINDS_EXTENSION,
    objects: {},
    settings: {},
    permissions: { modules: [ROUTINE_MAIL_MODULE] },
    routineMail: { [name]: kind },
  });
  if (issues.length) {
    throw new Error(
      `Host kind ${name}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }
  declared.set(name, kind);
}

/** A host kind's declaration by name, or undefined. */
export function hostRoutineKind(name: string): RoutineMailKindManifest | undefined {
  return declared.get(name);
}

/** Every host kind, by name. */
export function hostRoutineKinds(): [string, RoutineMailKindManifest][] {
  return [...declared.entries()].sort(([a], [b]) => a.localeCompare(b));
}
