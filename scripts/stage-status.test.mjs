import assert from "node:assert/strict";
import { test } from "node:test";
import { nextList, parseSpec, summarise } from "./stage-status.mjs";

const spec = (stage, status) =>
  parseSpec(
    `docs/stages/${stage}-x.md`,
    `# Stage ${stage}: Stage ${stage}\n\nIntro.\n\n## Status\n\n${status}\n\n## Goal\n`,
  );

test("reads each step's state, references, branch and needs", () => {
  const { steps, problems } = spec(
    30,
    [
      "- **Step 1** — built — PR #339 — The table: migration 0960",
      "  and its views.",
      "",
      "- **Step 2** — in progress — branch `feat/stage-30-consent` — Consent",
      "",
      "- **Step 3** — not built — needs: step 1, stage 37 step 3, the first client — Push",
      "",
      "A note that is not a step.",
    ].join("\n"),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    steps.map((s) => [s.id, s.state]),
    [
      ["1", "built"],
      ["2", "in progress"],
      ["3", "not built"],
    ],
  );
  assert.equal(steps[0].refs, "PR #339");
  assert.equal(steps[1].branch, "feat/stage-30-consent");
  assert.deepEqual(
    steps[2].needs.map((n) => (n.external ? n.raw : `${n.stage}/${n.step}`)),
    ["30/1", "37/3", "the first client"],
  );
});

test("a spec without a Status section, or with a bullet it cannot read, is a problem", () => {
  const none = parseSpec("docs/stages/40-x.md", "# Stage 40: X\n\n## Goal\n");
  assert.match(none.problems[0], /no "## Status" section/);
  const bad = spec(
    41,
    "- **Step 1** — done — PR #1\n\n- **Step 2** — built — #2\n\n- **Step 3**: prose",
  );
  assert.equal(bad.problems.length, 3);
  const empty = spec(42, "Nothing yet.");
  assert.match(empty.problems[0], /no "- \*\*Step N\*\*/);
});

test("next lists the steps whose needs are all built, and the rest say what they wait on", () => {
  const specs = [
    spec(
      37,
      "- **Step 3** — in progress — branch `feat/x` — Delivery\n\n- **Step 4** — not built — Returns",
    ),
    spec(
      34,
      [
        "- **Step 1** — built — PR #380 — Adjustments",
        "- **Step 2** — not built — needs: step 1 — Codes",
        "- **Step 3** — not built — needs: stage 37 step 3 — Free postage",
        "- **Step 4** — not built — needs: an owner decision — Loyalty",
        "- **Step 5** — superseded — by stage 49 — Old",
      ].join("\n"),
    ),
  ];
  const { stages, problems } = summarise(specs);
  assert.deepEqual(problems, []);
  const s34 = stages.find((s) => s.stage === 34);
  assert.equal(`${s34.built}/${s34.total}`, "1/4");
  assert.deepEqual(
    s34.next.map((s) => s.id),
    ["2"],
  );
  assert.deepEqual(s34.waitsOn, ["stage 37 step 3", "an owner decision"]);
  assert.match(nextList(stages), /^stage 37 step 4 — Returns\nstage 34 step 2 — Codes$/);
});

test("a need naming a step no spec has is a problem", () => {
  const { problems } = summarise([
    spec(34, "- **Step 1** — not built — needs: stage 99 step 1 — X"),
  ]);
  assert.match(problems[0], /needs "stage 99 step 1", which no spec has/);
});

test("a step bullet's needs may wrap onto its indented lines", () => {
  const { steps, problems } = spec(
    30,
    "- **Step 8** — not built — needs: stage 30 step 3,\n  the first client — Go live\n  at the first client.",
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    steps[0].needs.map((n) => n.raw),
    ["stage 30 step 3", "the first client"],
  );
  assert.equal(steps[0].text, "Go live at the first client.");
});
