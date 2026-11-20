import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSkillsVersion } from "./check-skills-version.mjs";

const contract = (n) => `/** The contract. */\nexport const CONTRACT_VERSION = ${n};\n`;
const skill = (n) => `# Write an extension\n\nDescribes extension contract version ${n}.\n`;

test("skills that describe the SDK's contract version pass", () => {
  assert.deepEqual(
    checkSkillsVersion({
      contractSource: contract(1),
      versionFile: "1\n",
      skills: [["skills/write-extension/SKILL.md", skill(1)]],
    }),
    [],
  );
});

test("changing the contract version without touching skills/ fails, for the file and each skill", () => {
  const problems = checkSkillsVersion({
    contractSource: contract(2),
    versionFile: "1\n",
    skills: [
      ["skills/write-extension/SKILL.md", skill(1)],
      ["skills/add-automations-tools-dashboards/SKILL.md", skill(1)],
    ],
  });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /skills\/CONTRACT_VERSION says 1 and the SDK's CONTRACT_VERSION is 2/);
  assert.match(problems[1], /skills\/write-extension\/SKILL\.md describes contract version 1/);
});

test("moving only the number in skills/CONTRACT_VERSION still fails on each skill", () => {
  const problems = checkSkillsVersion({
    contractSource: contract(2),
    versionFile: "2\n",
    skills: [["skills/write-extension/SKILL.md", skill(1)]],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SKILL\.md describes contract version 1/);
});

test("a skill that names no contract version, a missing file and an empty folder fail", () => {
  assert.match(
    checkSkillsVersion({
      contractSource: contract(1),
      versionFile: "1",
      skills: [["skills/x/SKILL.md", "# X\n"]],
    })[0],
    /does not say "contract version <n>"/,
  );
  assert.deepEqual(
    checkSkillsVersion({ contractSource: contract(1), versionFile: null, skills: [] }),
    ["skills/CONTRACT_VERSION is missing"],
  );
  assert.deepEqual(
    checkSkillsVersion({ contractSource: contract(1), versionFile: "1", skills: [] }),
    ["skills/ has no SKILL.md"],
  );
});
