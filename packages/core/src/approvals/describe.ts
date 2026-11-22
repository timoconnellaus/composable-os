// A pending action in words a reviewer reads: "Update 38 people", "Create person", "Log activity".
// Pure and browser-safe: the Approvals inbox and the chat's cards show these titles, and the server
// builds the second step's labels and the exact phrase from them (ADR 0345), so they always agree.

export interface PreviewEntry {
  object: string;
  id: string;
  action: string;
  diff: Record<string, { before: unknown; after: unknown }>;
}

const NOUNS: Record<string, [string, string]> = {
  person: ["person", "people"],
  organisation: ["organisation", "organisations"],
  activity: ["activity", "activities"],
  task: ["task", "tasks"],
  affiliation: ["affiliation", "affiliations"],
  connected_app: ["connected app", "connected apps"],
  view: ["saved view", "saved views"],
};

export function noun(object: string, count = 1): string {
  const [one, many] = NOUNS[object] ?? [object.replace(/_/g, " "), `${object.replace(/_/g, " ")}s`];
  return count === 1 ? one : many;
}

const VERBS: Record<string, string> = {
  create: "Create",
  update: "Update",
  updateMany: "Update",
  delete: "Delete",
  deleteMany: "Delete",
  restore: "Restore",
  merge: "Merge",
  erase: "Erase",
  log: "Log",
  complete: "Complete",
  reopen: "Reopen",
  changeJob: "Change job of",
  end: "End",
};

/** "updateMany" → "Update"; unknown camelCase verbs are spelled out ("sendEmail" → "Send email"). */
export function verbOf(operation: string): string {
  const verb = operation.split(".").at(-1) ?? operation;
  if (VERBS[verb]) return VERBS[verb];
  return spelled(verb);
}

/** "sessionComplete" → "Session complete". */
function spelled(name: string): string {
  const words = name.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An extension tool's operation name: `x.<extension>.<tool>` (ADR 0023). */
export const TOOL_OPERATION_RE = /^x\.([a-z][a-z0-9]{1,29})\.([a-z][a-zA-Z0-9]{0,39})$/;

/** The extension and tool of an extension tool's operation (`x.<extension>.<tool>`), else null. */
export function toolOf(operation: string): { extension: string; tool: string } | null {
  const match = TOOL_OPERATION_RE.exec(operation);
  return match?.[1] && match[2] ? { extension: match[1], tool: match[2] } : null;
}

/**
 * What a queued extension tool will be run with, for the reviewer (ADR 0022 amendment,
 * 2026-11-22): a tool is not dry-run, so its pending action has no diff to show, and its inputs
 * are what there is to judge. One line per input, the value as text (JSON for objects and lists).
 */
export function toolInputs(input: unknown): { name: string; value: string }[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return [{ name: "input", value: JSON.stringify(input) }];
  }
  return Object.entries(input as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
  }));
}

/** Records of the operation's own object the preview touches, falling back to any record. */
function mainRecords(operation: string, preview: readonly PreviewEntry[]): PreviewEntry[] {
  const object = operation.split(".")[0] ?? "";
  const own = preview.filter((p) => p.object === object);
  return own.length ? own : [...preview];
}

/** A reviewer's title: "Update 38 people", "Create person", "Log activity". */
export function actionTitle(
  operation: string,
  preview: readonly PreviewEntry[],
  input?: unknown,
  bulkSize = 1,
): string {
  const base = baseTitle(operation, preview, input);
  // Nothing to preview (it runs on approval, or is a tool): the count it was queued with says
  // how much it touches, so "Run automation" over 500 records says so.
  return !preview.length && bulkSize > 1 ? `${base} (${bulkSize} records)` : base;
}

function baseTitle(operation: string, preview: readonly PreviewEntry[], input?: unknown): string {
  const args = (input ?? {}) as {
    id?: unknown;
    version?: unknown;
    eject?: unknown;
    title?: unknown;
    actionKind?: { label?: unknown } | null;
    connectionTitle?: unknown;
  };
  if (operation === OUTBOUND_OPERATION) return outboundTitle(args);
  if (operation === "extension.apply") {
    const what = `extension ${String(args.id ?? "")} ${String(args.version ?? "")}`.trim();
    return args.eject ? `Eject and install ${what}` : `Install ${what}`;
  }
  if (operation === "extension.dropHidden") {
    return `Drop hidden data of extension ${String(args.id ?? "")}`;
  }
  const tool = toolOf(operation);
  if (tool) return `${spelled(tool.tool)} (${tool.extension} tool)`;
  const object = operation.split(".")[0] ?? operation;
  const count = new Set(mainRecords(operation, preview).map((p) => p.id)).size;
  const verb = verbOf(operation);
  return count > 1 ? `${verb} ${count} ${noun(object, count)}` : `${verb} ${noun(object)}`;
}

/** The operation outbound (gatekeeper) items carry (ADR 0051). */
export const OUTBOUND_OPERATION = "integration.outbound";

/**
 * An outbound item's title: the gatekeeper's own ("Send mail to ada@example.com"), else its
 * action kind's label, else a generic one naming the connection.
 */
export function outboundTitle(input: {
  title?: unknown;
  actionKind?: { label?: unknown } | null;
  connectionTitle?: unknown;
}): string {
  if (typeof input.title === "string" && input.title.trim()) return input.title.trim();
  const kind = input.actionKind?.label;
  if (typeof kind === "string" && kind.trim()) return kind.trim();
  return typeof input.connectionTitle === "string" && input.connectionTitle
    ? `Outbound action on ${input.connectionTitle}`
    : "Outbound action";
}
