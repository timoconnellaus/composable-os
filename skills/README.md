# Skills

Instructions for an agent building on Composable OS (ADR 0405). Each folder is one skill: a
`SKILL.md` with standard skill frontmatter (`name`, `description`) and plain Markdown that any
agent can read. `.claude/skills/` links to each folder so Claude Code loads them; other agents are
pointed here from `AGENTS.md`.

| Skill | For |
| --- | --- |
| [`write-extension`](write-extension/SKILL.md) | A new extension: objects, fields, relations, permissions, views, behaviours |
| [`add-automations-tools-dashboards`](add-automations-tools-dashboards/SKILL.md) | Tools, automations and dashboards on an extension |

Every skill has the same four parts: when to use it, the steps, the rules, and the check command.
A skill points at code and at the Deals extension; it does not copy them.

`CONTRACT_VERSION` holds the extension contract version these skills describe, and each skill
says it. `pnpm lint` fails when the SDK's `CONTRACT_VERSION` is a different number
(`scripts/check-skills-version.mjs`): update the skills, then the number.

There is no eval of the skills. When a skill leads an agent wrong, fix the skill.
