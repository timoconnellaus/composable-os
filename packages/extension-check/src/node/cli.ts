// The `cos ext` commands (ADR 0405). `runExt` is called by the cos command with what follows
// `ext` on the command line; it returns the exit code.
import { relative, resolve } from "node:path";
import { checkExtensionDir, ExtCheckError, type LocatedIssue } from "./check.ts";
import { runVitest, untested } from "./test.ts";

export interface ExtIo {
  out(line: string): void;
  err(line: string): void;
}

export const EXT_HELP = `cos ext: check and test an extension in a Composable OS checkout.

  cos ext check <dir> [--json]   The checks extension.check runs in a deployment: allowed imports,
                                 types against @composable-os/sdk, the contract, formulas,
                                 automations, and a dry-run reconcile against an empty local
                                 database. Exit code 0 only when there are no issues.
  cos ext test <dir>             The extension's Vitest tests. Fails first if a tool or an
                                 automation is named in no test file.
`;

/** One issue as text: where, what, and the fix when the check has one. */
export function formatIssue(dir: string, issue: LocatedIssue): string {
  const file = `${dir}/${issue.file}${issue.line ? `:${issue.line}` : ""}`;
  const at = issue.stage === "typecheck" ? "" : `  ${issue.path}`;
  const lines = [`${file}${at}`, `  ${issue.stage}/${issue.code}: ${issue.message}`];
  if (issue.suggestion) lines.push(`  fix: ${issue.suggestion}`);
  return lines.join("\n");
}

async function check(dir: string, json: boolean, io: ExtIo): Promise<number> {
  const result = await checkExtensionDir(dir);
  if (json) {
    io.out(
      JSON.stringify(
        {
          id: result.id,
          ok: result.ok,
          issues: result.issues,
          outside: outsideSummary(result.manifest),
          roles: rolesSummary(result.manifest),
        },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }
  const shown = relative(process.cwd(), resolve(dir)) || ".";
  for (const issue of result.issues) io.out(`${formatIssue(shown, issue)}\n`);
  if (!result.ok) {
    const n = result.issues.length;
    io.out(`${n} issue${n === 1 ? "" : "s"} in ${shown}. Fix them and run the check again.`);
    return 1;
  }
  const changes = result.plan?.changes.length ?? 0;
  io.out(
    `ok: ${result.id} ${result.manifest?.version ?? ""} passes the check ` +
      `(${changes} schema change${changes === 1 ? "" : "s"} on an empty database).`,
  );
  // What the extension opens to people outside the org is said out loud (ADR 0402, ADR 0414).
  for (const line of outsideSummary(result.manifest)) io.out(line);
  // So is what its staff roles let an account do (ADR 0436).
  for (const line of rolesSummary(result.manifest)) io.out(line);
  // And what it emails members without a person's approval (ADR 0590).
  for (const line of routineMailSummary(result.manifest)) io.out(line);
  // And the moments about a Person it lets a journey start or stop on (stage 53, ADR 0802).
  for (const line of journeySignalsSummary(result.manifest)) io.out(line);
  return 0;
}

/**
 * One line for each journey signal the manifest declares (stage 53, ADR 0802): what the host
 * records about a Person on every write. Empty when it declares none.
 */
export function journeySignalsSummary(
  manifest:
    | {
        id: string;
        journeySignals?: Record<
          string,
          { label: string; object: string; enters?: string[]; from?: string[] }
        >;
      }
    | null
    | undefined,
): string[] {
  const signals = Object.entries(manifest?.journeySignals ?? {});
  if (!manifest || !signals.length) return [];
  return [
    "This extension declares journey signals, recorded by the host for the Person on every write:",
    ...signals.map(
      ([name, signal]) =>
        `  ${manifest.id}.${name} (${signal.label}): ${signal.object} ` +
        (signal.enters
          ? `enters ${signal.enters.join(" or ")}${signal.from ? ` from ${signal.from.join(" or ")}` : ""}`
          : "created"),
    ),
  ];
}

/**
 * One line for each kind of routine mail the manifest declares (ADR 0590): email the host sends
 * without a person's approval, about which record, and its messages. Empty when it declares none.
 */
export function routineMailSummary(
  manifest:
    | {
        id: string;
        routineMail?: Record<
          string,
          { label: string; about: string; on?: boolean; messages: Record<string, unknown> }
        >;
      }
    | null
    | undefined,
): string[] {
  const kinds = Object.entries(manifest?.routineMail ?? {});
  if (!manifest || !kinds.length) return [];
  return [
    "This extension declares routine email, sent without a person's approval to whoever the " +
      "record belongs to. Review its words:",
    ...kinds.map(
      ([name, kind]) =>
        `  ${manifest.id}.${name} (${kind.label}): about ${kind.about}; messages ` +
        `${Object.keys(kind.messages).join(", ")}${kind.on === false ? "; off until an admin turns it on" : ""}`,
    ),
  ];
}

/**
 * One line for each staff role the manifest declares (ADR 0436): what an account given it may do,
 * which is all it may do. Empty when it declares none.
 */
export function rolesSummary(
  manifest:
    | {
        id: string;
        roles?: Record<
          string,
          {
            label: string;
            permissions: string[];
            read: string[];
            looksAfter?: Record<string, string>;
          }
        >;
        grantable?: string[];
        restricted?: string[];
        tools?: Record<string, { permission?: string | string[] }>;
      }
    | null
    | undefined,
): string[] {
  const roles = Object.entries(manifest?.roles ?? {});
  const grantable = manifest?.grantable ?? [];
  const restricted = manifest?.restricted ?? [];
  if (!manifest || (!roles.length && !grantable.length && !restricted.length)) return [];
  const opens = (permission: string) =>
    Object.entries(manifest.tools ?? {})
      .filter(([, tool]) =>
        (typeof tool.permission === "string"
          ? [tool.permission]
          : (tool.permission ?? [])
        ).includes(permission),
      )
      .map(([name]) => name);
  return [
    ...(roles.length
      ? [
          grantable.length
            ? "This extension declares staff roles. An account given one may do this, and what it is granted below, and nothing else:"
            : "This extension declares staff roles. An account given one may do this and nothing else:",
          ...roles.map(
            ([name, role]) =>
              `  role ${manifest.id}.${name} (${role.label}): tools with ${role.permissions.join(", ") || "no permission"}; ` +
              `reads ${role.read.join(", ") || "nothing"}` +
              // Limited to the People its holder looks after (ADR 0889).
              (role.looksAfter && Object.keys(role.looksAfter).length
                ? `; only the people its holder looks after on ${Object.keys(role.looksAfter).join(", ")}`
                : ""),
          ),
        ]
      : []),
    // Granted one by one by a human admin (ADR 0449), to a role's account too (ADR 0600).
    ...(grantable.length
      ? [
          "Permissions an admin may grant one by one (to an account with a role too):",
          ...grantable.map(
            (permission) =>
              `  ${permission}: tools ${opens(permission).join(", ") || "none"}${restricted.includes(permission) ? " (restricted)" : ""}`,
          ),
        ]
      : []),
    // Held by admins and by grant only (ADR 0625): a member does not hold these tools.
    ...(restricted.length
      ? [
          `Restricted (admins, and accounts an admin granted it; never a member otherwise): ${restricted.join(", ")}`,
        ]
      : []),
  ];
}

/** The parts of a manifest this reads. */
interface OpensOutside {
  id: string;
  objects: Record<
    string,
    {
      customer?: {
        field: string;
        read: string[];
        write: string[];
        guardians?: { write?: boolean; madeBy?: string };
        delete?: boolean;
      };
      public?: { read: string[]; when?: { via?: string; field: string; in: string[] } };
      signedIn?: { read: string[]; when?: { via?: string; field: string; in: string[] } };
      customerVia?: { from: string; field: string; read: string[] };
      sellable?: {
        price: string;
        grants?: { object: string };
        moves?: {
          held: string;
          paid: string;
          expired: string;
          refund?: readonly string[];
          price?: { field?: string; setting?: string };
        };
      };
      publishable?: { content: string[]; slug?: string };
    }
  >;
  tools: Record<
    string,
    { risk: string; audiences?: string[]; customerFields?: Record<string, string[]> }
  >;
}

/**
 * One line for each thing a manifest opens to customers or the public: objects a customer can
 * see, and tools they can call, with the fields a tool may set beyond the object's own list.
 * Empty when the extension is for staff only.
 */
export function outsideSummary(manifest: OpensOutside | null | undefined): string[] {
  if (!manifest) return [];
  const lines: string[] = [];
  for (const [name, object] of Object.entries(manifest.objects)) {
    if (object.sellable) {
      const grants = object.sellable.grants;
      const moves = object.sellable.moves;
      lines.push(
        moves
          ? `  anyone can have the host make ${manifest.id}.${name} held ("${moves.held}") while its order is unpaid, priced by ${moves.price?.field ?? object.sellable.price}${moves.price?.setting ? ` else the setting ${moves.price.setting}` : ""}; paid: "${moves.paid}"; unpaid: "${moves.expired}"${moves.refund?.length ? `; a refund a person approves on ${moves.refund.join(", ")}` : ""}`
          : `  anyone can buy ${manifest.id}.${name} (priced by ${object.sellable.price})` +
              (grants ? `; a paid line grants ${grants.object}` : ""),
      );
    }
    const p = object.public;
    if (p) {
      const via = p.when?.via ? `its ${p.when.via}'s ` : "";
      const while_ = p.when
        ? ` while ${via}${p.when.field} is ${p.when.in.join(" or ")}`
        : object.publishable
          ? ""
          : ", every record";
      // A publishable object's public reads its published versions only (ADR 0442).
      const published = object.publishable ? ", published versions only, by its slug" : "";
      lines.push(
        `  the public sees ${manifest.id}.${name}${published}${while_}: read ${p.read.join(", ")}`,
      );
    }
    const s = object.signedIn;
    if (s) {
      const via = s.when?.via ? `its ${s.when.via}'s ` : "";
      const while_ = s.when
        ? ` while ${via}${s.when.field} is ${s.when.in.join(" or ")}`
        : ", every record";
      lines.push(
        `  every signed-in customer sees ${manifest.id}.${name}${while_}: read ${s.read.join(", ")}`,
      );
    }
    const v = object.customerVia;
    if (v) {
      lines.push(
        `  customers see ${manifest.id}.${name} where their own ${v.from}'s ${v.field} points to it: ` +
          `read ${v.read.join(", ")}`,
      );
    }
    const c = object.customer;
    if (!c) continue;
    // The family link (ADR 0540): a linked guardian too, reading (and maybe writing) the same.
    const g = c.guardians;
    const whose = g
      ? `is them or a child linked to them (${g.write ? "read and write" : "read only"})`
      : "is them";
    lines.push(
      `  customers see ${manifest.id}.${name} where ${c.field} ${whose}: ` +
        `read ${c.read.join(", ") || "nothing"}; write ${c.write.join(", ") || "nothing"}` +
        // A customer's own records they may put in the Trash (ADR 0414, amended).
        (c.delete ? "; may put their own in the Trash (my.delete)" : ""),
    );
  }
  for (const [name, tool] of Object.entries(manifest.tools)) {
    const open = (tool.audiences ?? []).filter((audience) => audience !== "staff");
    if (!open.length) continue;
    const widened = Object.entries(tool.customerFields ?? {})
      .map(([object, fields]) => `${object}: ${fields.join(", ")}`)
      .join("; ");
    lines.push(
      `  tool ${name} (${tool.risk}) is open to ${open.join(" and ")}` +
        (widened ? `, and may also set ${widened}` : ""),
    );
  }
  return lines.length
    ? ["This extension opens the host to people outside the org. Review these lines:", ...lines]
    : [];
}

async function test(dir: string, io: ExtIo): Promise<number> {
  const missing = await untested(dir);
  if (missing.length) {
    for (const name of missing) io.out(`No test names ${name}.`);
    io.out(
      "Every tool and automation needs at least one test (createTestHost in " +
        "@composable-os/sdk/testing: runTool, runAutomation).",
    );
    return 1;
  }
  return runVitest(dir);
}

export async function runExt(argv: string[], io: ExtIo): Promise<number> {
  const args = argv.filter((arg) => !arg.startsWith("--"));
  const [command, dir] = args;
  if (!command || argv.includes("--help") || (command !== "check" && command !== "test") || !dir) {
    io.out(EXT_HELP);
    return command && dir ? 2 : argv.includes("--help") ? 0 : 2;
  }
  try {
    return command === "check"
      ? await check(dir, argv.includes("--json"), io)
      : await test(dir, io);
  } catch (error) {
    if (error instanceof ExtCheckError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
