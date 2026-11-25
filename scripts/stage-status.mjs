#!/usr/bin/env node
// Where every stage stands, read from the specs (`pnpm stage:status`).
//
// Each stage spec (docs/stages/NN-*.md) has a `## Status` section with one bullet per build step
// from the spec's "Suggested build order" (CONTRIBUTING.md, Working in parallel):
//
//   - **Step 3** — built — PR #429 — The answers screen: what it built, migrations, ADRs
//   - **Step 4** — in progress — branch `feat/stage-30-consent` — Consent
//   - **Step 5** — not built — needs: step 3, stage 37 step 3, the first client — Free postage
//   - **Step 6** — unclear — <why it cannot be told from git> — The name of the step
//   - **Step 7** — superseded — by stage 49 — The name of the step
//
// A stage built before this format may have one bullet, `- **All steps** — built — PR #2 — ...`.
// A bullet may continue on lines indented two spaces (read as one line with it), and bullets are kept apart by a blank line so that two
// pull requests editing different steps do not conflict. Other lines in the section are notes.
//
// Needs are separated by commas. `step M`, `stage NN step M` and `stage NN` (every step of it)
// are met when built; anything else (the first client, a real Stripe account, an owner decision)
// is never met by a build session and is reported as what the stage waits on.
//
// Flags: `--json` prints the parsed specs; `--next` lists every step not built whose needs are all
// met; `--check` (run by `pnpm lint`) prints nothing but problems. Every mode exits 1 when a spec
// has no Status section or a step bullet it cannot read.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STATES = ["built", "in progress", "not built", "unclear", "superseded"];

const SEP = " — ";
const STEP_LINE = /^- \*\*(Step [0-9]+[a-z]?|Step W[0-9]+|All steps)\*\*(.*)$/;
const REF = String.raw`(?:PRs? #\d+(?:, #\d+)*|commit [0-9a-f]{7,40})`;
const REFS = new RegExp(`^${REF}(?:; ${REF})*$`);
const BRANCH = /^branch `[^`]+`$/;

/** Reads one need: a step of this stage, a step of another, a whole stage, or something outside. */
export function parseNeed(raw, stage) {
  const text = raw.trim();
  let m = text.match(/^step ([0-9]+[a-z]?|W[0-9]+)$/);
  if (m) return { raw: text, stage, step: m[1] };
  m = text.match(/^stage (\d+) step ([0-9]+[a-z]?|W[0-9]+)$/);
  if (m) return { raw: text, stage: Number(m[1]), step: m[2] };
  m = text.match(/^stage (\d+)$/);
  if (m) return { raw: text, stage: Number(m[1]), step: null };
  return { raw: text, external: true };
}

/**
 * Parses one spec's text.
 * @returns {{ stage: number, name: string, file: string, steps: object[], problems: string[] }}
 */
export function parseSpec(file, text) {
  const problems = [];
  const lines = text.split("\n");
  const title = lines[0].match(/^# Stage (\d+): (.+)$/);
  const stage = title ? Number(title[1]) : Number(file.match(/(\d+)-/)?.[1] ?? Number.NaN);
  if (!title) problems.push(`${file}:1: the first line is not "# Stage NN: Name"`);
  const name = title ? title[2] : file;
  const steps = [];
  const start = lines.indexOf("## Status");
  if (start === -1) {
    problems.push(`${file}: no "## Status" section`);
    return { stage, name, file, steps, problems };
  }
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (!/^- \*\*(Step|All steps)/.test(lines[i])) continue;
    const at = i + 1;
    const where = `${file}:${at}`;
    // The bullet's indented continuation lines are part of it: a needs list may wrap.
    let line = lines[i].trimEnd();
    while (/^ {2}\S/.test(lines[i + 1] ?? "")) line += ` ${lines[++i].trim()}`;
    const m = line.match(STEP_LINE);
    if (!m?.[2].startsWith(SEP)) {
      problems.push(
        `${where}: a step bullet is "- **Step N** — <state> — ...": ${line.slice(0, 60)}`,
      );
      continue;
    }
    const id = m[1] === "All steps" ? "all" : m[1].slice(5);
    const fields = m[2].slice(SEP.length).split(SEP);
    const state = fields.shift().trim();
    if (!STATES.includes(state)) {
      problems.push(`${where}: step ${id}: "${state}" is not one of ${STATES.join(", ")}`);
      continue;
    }
    const step = {
      id,
      state,
      refs: null,
      branch: null,
      needs: [],
      reason: null,
      text: "",
      line: at,
    };
    if (state === "built") {
      const refs = fields.shift()?.trim() ?? "";
      if (!REFS.test(refs)) {
        problems.push(`${where}: step ${id}: built needs "PR #N", "PRs #N, #M" or "commit <sha>"`);
        continue;
      }
      step.refs = refs;
    } else if (state === "in progress") {
      const branch = fields.shift()?.trim() ?? "";
      if (!BRANCH.test(branch)) {
        problems.push(`${where}: step ${id}: in progress needs "branch \`name\`"`);
        continue;
      }
      step.branch = branch.slice(8, -1);
    } else if (state === "unclear" || state === "superseded") {
      const reason = fields.shift()?.trim() ?? "";
      if (!reason) {
        problems.push(`${where}: step ${id}: ${state} needs a reason`);
        continue;
      }
      step.reason = reason;
    }
    if (state === "not built" && fields[0]?.startsWith("needs: ")) {
      step.needs = fields
        .shift()
        .slice(7)
        .split(",")
        .map((n) => parseNeed(n, stage));
    }
    step.text = fields.join(SEP).trim();
    if (steps.some((s) => s.id === id)) {
      problems.push(`${where}: step ${id} appears twice`);
      continue;
    }
    steps.push(step);
  }
  if (steps.length === 0 && !problems.length) {
    problems.push(`${file}: the Status section has no "- **Step N** — <state>" bullet`);
  }
  return { stage, name, file, steps, problems };
}

/** Whether a need is met, given every parsed spec by stage number. */
function met(need, byStage) {
  if (need.external) return false;
  const spec = byStage.get(need.stage);
  if (!spec) return false;
  const counted = spec.steps.filter((s) => s.state !== "superseded");
  if (need.step === null) return counted.length > 0 && counted.every((s) => s.state === "built");
  const step = spec.steps.find((s) => s.id === need.step);
  return step?.state === "built" || step?.state === "superseded";
}

/** Checks that every internal need names a stage and step that exist. */
function checkNeeds(specs, byStage) {
  const problems = [];
  for (const spec of specs) {
    for (const step of spec.steps) {
      for (const need of step.needs) {
        if (need.external) continue;
        const target = byStage.get(need.stage);
        const exists =
          target && (need.step === null || target.steps.some((s) => s.id === need.step));
        if (!exists)
          problems.push(
            `${spec.file}:${step.line}: step ${step.id} needs "${need.raw}", which no spec has`,
          );
      }
    }
  }
  return problems;
}

/** The summary of every stage: what is built, what can be built next, and what it waits on. */
export function summarise(specs) {
  const byStage = new Map(specs.map((s) => [s.stage, s]));
  const problems = [...specs.flatMap((s) => s.problems), ...checkNeeds(specs, byStage)];
  const stages = specs.map((spec) => {
    const counted = spec.steps.filter((s) => s.state !== "superseded");
    const next = [];
    const waits = new Set();
    for (const step of spec.steps) {
      if (step.state === "in progress") continue;
      if (step.state === "unclear") waits.add(`step ${step.id} unclear`);
      if (step.state !== "not built") continue;
      const unmet = step.needs.filter((n) => !met(n, byStage));
      if (unmet.length === 0) next.push(step);
      for (const n of unmet) if (n.external || n.stage !== spec.stage) waits.add(n.raw);
    }
    return {
      stage: spec.stage,
      name: spec.name,
      file: spec.file,
      built: counted.filter((s) => s.state === "built").length,
      total: counted.length,
      inProgress: spec.steps.filter((s) => s.state === "in progress"),
      next,
      waitsOn: [...waits],
      steps: spec.steps,
    };
  });
  return { stages, problems };
}

/** Reads every spec under docs/stages. */
export function readSpecs(root) {
  const dir = join(root, "docs", "stages");
  return readdirSync(dir)
    .filter((f) => /^\d+-.+\.md$/.test(f))
    .map((f) => parseSpec(`docs/stages/${f}`, readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.stage - b.stage);
}

const label = (step) => (step.id === "all" ? "all" : step.id);

function short(text, n = 70) {
  const first = text.split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, "");
  return first.length > n ? `${first.slice(0, n - 1)}…` : first;
}

export function table(stages) {
  const rows = stages.map((s) => [
    String(s.stage),
    s.name.length > 34 ? `${s.name.slice(0, 33)}…` : s.name,
    `${s.built}/${s.total}`,
    [...s.next.map(label), ...s.inProgress.map((p) => `${label(p)} (in progress)`)].join(", ") ||
      "-",
    s.waitsOn.join("; ") || "-",
  ]);
  const head = ["Stage", "Name", "Built", "Next", "Waits on"];
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export function nextList(stages) {
  return stages
    .flatMap((s) =>
      s.next.map((step) => `stage ${s.stage} step ${label(step)} — ${short(step.text)}`),
    )
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = new Set(process.argv.slice(2));
  const { stages, problems } = summarise(readSpecs(root));
  if (args.has("--json")) console.log(JSON.stringify({ stages, problems }, null, 2));
  else if (args.has("--next")) console.log(nextList(stages));
  else if (!args.has("--check")) console.log(table(stages));
  if (problems.length) {
    console.error(
      `Stage specs whose Status cannot be read (CONTRIBUTING.md, Working in parallel):`,
    );
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  }
}
