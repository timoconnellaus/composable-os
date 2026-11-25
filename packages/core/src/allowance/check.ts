// The host's checks of an allowance declaration against what is installed (stage 32b, ADR 0494),
// run by extension.check, extension.install and `cos ext check` (checkManifest). The SDK checks a
// manifest on its own; what it cannot see (another extension's spender, a field one relation away
// in another extension or a core object) is checked here against the registry:
//
// - a holder naming another extension's spender: that spender must exist and declare `spends`,
//   must let this holder pay for it (`paidBy`, default its own extension only), and every field a
//   condition reads must be one the spender's host fills;
// - a spender's `at`, `copy` and `local.zone` one relation away into another extension or a core
//   object: the field must exist and be of the right type.
//
// A holder naming a spender that is not installed yet is not refused (install order is free); it
// pays for nothing until the spender is installed and allows it, which the host also checks on
// every spend (payingObjects).
import {
  type ExtensionManifest,
  hostFilledFields,
  spenderAllows,
  spendsOnList,
} from "@composable-os/sdk";
import { getObject } from "../fields/index.ts";

export interface AllowanceIssue {
  path: string;
  message: string;
}

export function allowanceHostIssues(m: ExtensionManifest): AllowanceIssue[] {
  const issues: AllowanceIssue[] = [];
  for (const [name, object] of Object.entries(m.objects)) {
    const allowance = object.allowance;
    if (!allowance) continue;
    const ap = `objects.${name}.allowance`;
    if ("holds" in allowance) {
      spendsOnList(allowance.holds).forEach((target, i) => {
        if (!target.object.includes(".") || target.object.startsWith(`${m.id}.`)) return;
        const p = Array.isArray(allowance.holds.spendsOn)
          ? `${ap}.holds.spendsOn.${i}`
          : `${ap}.holds.spendsOn`;
        const spender = getObject(target.object);
        if (!spender) return;
        const def = spender.allowance;
        if (def?.kind !== "spender") {
          issues.push({ path: `${p}.object`, message: `${target.object} does not spend uses` });
          return;
        }
        const ext = target.object.split(".")[0] as string;
        if (!spenderAllows({ paidBy: def.paidBy }, ext, `${m.id}.${name}`)) {
          issues.push({
            path: `${p}.object`,
            message: `${target.object} does not let ${m.id}.${name} pay for it: its paidBy must list ${m.id} or ${m.id}.${name}`,
          });
        }
        const filled = new Set(hostFilledFields({ copy: def.copy, local: def.local }));
        (target.when ?? []).forEach((clause, j) => {
          if (clause.field !== undefined && !filled.has(clause.field)) {
            issues.push({
              path: `${p}.when.${j}.field`,
              message: `"${clause.field}" must be a field ${target.object}'s host fills (its copy or local), so no caller sets what pays for it`,
            });
          }
        });
      });
      continue;
    }
    const s = allowance.spends;
    const hops: [string, string, string | null][] = [
      ...(s.at?.includes(".")
        ? [[`${ap}.spends.at`, s.at, "datetime"] as [string, string, string]]
        : []),
      ...(s.local?.zone?.includes(".")
        ? [[`${ap}.spends.local.zone`, s.local.zone, "timezone"] as [string, string, string]]
        : []),
      ...Object.entries(s.copy ?? {}).map(
        ([local, source]) => [`${ap}.spends.copy.${local}`, source, null] as [string, string, null],
      ),
    ];
    for (const [p, path, type] of hops) {
      const [rel, target] = path.split(".") as [string, string];
      const to = object.fields[rel]?.type === "relation" ? object.fields[rel]?.to : undefined;
      if (!to || to.startsWith(`${m.id}.`)) continue; // The SDK checks this extension's own.
      const other = getObject(to);
      if (!other) {
        issues.push({ path: p, message: `${to} is not installed, so "${path}" cannot be read` });
        continue;
      }
      // The related record's own id (ADR 0764), copied as it is.
      if (target === "id" && type === null) continue;
      const field = other.fields.find((f) => f.name === target);
      if (!field) {
        issues.push({ path: p, message: `"${target}" is not a field of ${to}` });
        continue;
      }
      const actual = field.fieldType ?? field.type;
      if (type && actual !== type) {
        issues.push({ path: p, message: `"${path}" must be a ${type} field (it is ${actual})` });
      }
    }
  }
  return issues;
}
