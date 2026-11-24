// The host modules a client repo takes from the template (ADR 0451, amended 2026-11-21): each app's
// framework-free module that reaches the host (`host.ts`; the mobile app's `secure-store.ts` and
// `secure-random.ts`). `cos create` and `cos init` write them; `cos upgrade` keeps them current:
//
// - What was written is recorded, a sha256 per module, in `composable-os.lock.json`.
// - On upgrade a module the company has not edited (its file still has the recorded hash) is
//   replaced with the new template's. An edited one is left as it is, and its diff against the new
//   template is shown with what to do, as `cos diff` does for blocks. A module with no recorded
//   hash (a repo adopted before this) counts as edited, unless it already equals the new template.
// - Compared by content, not by version: a kit rebuilt at the same version still shows a change.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientProductDefinition } from "@composable-os/product";
import { lineDiff } from "./diff.ts";
import type { Io } from "./io.ts";

/** The repo's record of what cos wrote that is not a block (blocks are in blocks.lock.json). */
export const STATE_FILE = "composable-os.lock.json";

const MODULES = { web: ["host.ts"], mobile: ["host.ts", "secure-store.ts", "secure-random.ts"] };

interface State {
  hostModules?: Record<string, { template: string; version: string; sha256: string }>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function readState(root: string): State {
  const path = join(root, STATE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : {};
}

function writeState(root: string, state: State) {
  const modules = Object.fromEntries(
    Object.entries(state.hostModules ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    join(root, STATE_FILE),
    `${JSON.stringify({ ...state, hostModules: modules }, null, 2)}\n`,
  );
}

/** Where each host module of a repo lives, and the template file it comes from. */
export function hostModulePlaces(
  product: ClientProductDefinition,
): { path: string; template: string; adopted: boolean }[] {
  const out: { path: string; template: string; adopted: boolean }[] = [];
  for (const kind of ["web", "mobile"] as const) {
    const app = product[kind];
    if (!app) continue;
    const clientDir = app.clientDir ?? "src/client";
    // The template's layout: the module in src/, its client in src/client/. An adopted app: both
    // in the folder cos init chose (src/composable-os/).
    const adopted = clientDir !== "src/client";
    for (const file of MODULES[kind]) {
      out.push({
        path: join(app.dir, adopted ? clientDir : "src", file)
          .split("\\")
          .join("/"),
        template: `apps/${kind}/src/${file}`,
        adopted,
      });
    }
  }
  return out;
}

/** A host module's text as this repo has it from `kit`: the template's, its import adjusted. */
function templateText(
  kit: Map<string, Uint8Array>,
  place: { template: string; adopted: boolean },
): string | null {
  const bytes = kit.get(`template/${place.template}`);
  if (!bytes) return null;
  const text = decode(bytes);
  return place.adopted ? text.replaceAll("./client/customer.ts", "./customer.ts") : text;
}

/**
 * Records every host module that is the template's as `kit` has it (just written by cos create or
 * cos init). A module that differs from it is not recorded: it was there before, the company's.
 */
export function recordHostModules(
  root: string,
  product: ClientProductDefinition,
  kit: Map<string, Uint8Array>,
  version: string,
): void {
  const state = readState(root);
  state.hostModules ??= {};
  for (const place of hostModulePlaces(product)) {
    const path = join(root, place.path);
    const text = templateText(kit, place);
    if (text === null || !existsSync(path) || readFileSync(path, "utf8") !== text) continue;
    state.hostModules[place.path] = { template: place.template, version, sha256: sha(text) };
  }
  writeState(root, state);
}

/**
 * Brings the host modules to `kit`'s template (cos upgrade): replaces each one the company has
 * not edited, writes one the new template adds, and for an edited one writes nothing and shows its
 * diff against the new template. Returns the paths left to merge by hand.
 */
export function upgradeHostModules(
  root: string,
  product: ClientProductDefinition,
  kit: Map<string, Uint8Array>,
  version: string,
  io: Io,
): string[] {
  const state = readState(root);
  state.hostModules ??= {};
  const modules = state.hostModules;
  const replaced: string[] = [];
  const edited: string[] = [];
  for (const place of hostModulePlaces(product)) {
    const next = templateText(kit, place);
    if (next === null) continue;
    const path = join(root, place.path);
    const recorded = modules[place.path];
    const record = () => {
      modules[place.path] = {
        template: place.template,
        version,
        sha256: sha(next),
      };
    };
    if (!existsSync(path)) {
      // New in this template (secure-random.ts for an app adopted before it): written.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
      record();
      replaced.push(`${place.path} (new)`);
      continue;
    }
    const current = readFileSync(path, "utf8");
    if (current === next) {
      record();
      continue;
    }
    if (recorded && sha(current) === recorded.sha256) {
      writeFileSync(path, next);
      record();
      replaced.push(place.path);
      continue;
    }
    edited.push(place.path);
    io.out(
      `\n${place.path}: ${recorded ? "edited here since cos wrote it" : "no record of what cos wrote (adopted before host modules were recorded), so treated as edited"}. Not changed. The new template's changes, to apply by hand:`,
    );
    io.out(`--- ${place.path} (here)\n+++ ${place.path} (template, ${version})`);
    for (const line of lineDiff(current, next)) io.out(line);
  }
  writeState(root, state);
  if (replaced.length) io.out(`Host modules: ${replaced.join(", ")} replaced with ${version}'s.`);
  if (edited.length) {
    io.out(
      `\nHost modules left to merge by hand: ${edited.join(", ")}. Merge the diff above (or take the template's file as it is, if your edits are no longer needed); once a file equals the template, cos records it and replaces it on later upgrades.`,
    );
  }
  return edited;
}
