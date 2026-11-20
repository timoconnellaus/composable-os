---
name: add-automations-tools-dashboards
description: Add tools, automations and dashboards to a Composable OS extension that already exists, the way Deals and Leads do - a tool with its risk class and an optional button on a record page, an automation with its trigger, conditions and declared steps (what each step reads, writes, notifies and calls, and the permissions those need), a dashboard of read-only SQL over the rec_* views with a chart mapping and a click-through, and a test for every tool and automation. Use when asked for an action on a record, something that happens on its own (a reminder, a follow-up task, a daily scan) or charts and numbers over an extension's records. Write the extension first with write-extension.
---

# Add tools, automations and dashboards

Describes extension contract version 1 (`CONTRACT_VERSION` in `packages/sdk/src/contract.ts`).

## When to use it

Someone asks for something an extension does rather than stores: an action on a record ("convert
this lead"), work that happens on its own (remind the owner, create follow-up tasks every
morning), or numbers and charts over its records. The extension and its objects exist already;
if not, start with `write-extension`. It is for a shipped extension in `extensions/<id>/`.

- A **tool** is an operation `x.<id>.<tool>` that a person, the assistant or an MCP client
  calls, and can be a button on a record page.
- An **automation** runs by itself after a change, on a schedule or from a button.
- A **dashboard** is read-only charts over the records. It changes nothing.

## The steps

Read these before writing. They are the source of truth; this skill only gives the order.

- `packages/sdk/README.md`: "Host modules (`ctx`)", "Testing an extension", "Testing an
  automation", "Automations", and the `tools` and `dashboards` rows of the contract table.
- `packages/sdk/src/contract.ts`: `ToolSpec`, `RecordActionSpec`, `TOOL_RISKS`,
  `ExtensionContext`, `PermissionsSpec`, `DashboardDeclaration`, `WidgetDeclaration`.
  `automation.ts`: `AutomationSpec`, `AutomationTrigger`, `AutomationStep`, `WriteIntent`,
  `NotifyIntent`, `Recipient`. `automation-check.ts` is what the check refuses.
- `packages/core/src/dashboards/spec.ts`: the spec shipped dashboards are validated against
  (filter types, `widgetMappingSchema`, `widgetOptionsSchema`, `clickThroughSchema`,
  `SYSTEM_PARAMS`). `click-through.ts` beside it turns a click into a list filter.
- The worked examples: `extensions/deals/` (`tools.ts`, `automations.ts`, `dashboards.ts`,
  `test/`) and `extensions/leads/` (`tools.ts`, `automations.ts`, `dashboards.ts`).

Each kind has its own file, wired into `defineExtension` (Deals: the last keys of `index.ts`).

1. **Write a tool** with `defineTool`: a camelCase name, a `description` written for a model
   (what it does, when to use it, its side effects), zod `input` (a `z.object`) and `output`, and
   `handler(input, ctx)`. Reach data only with `ctx.ops.call`; fail with `OpsCallError` and a
   code (Leads: `convert` throws `conflict`). See Deals: `stageMetrics`; Leads: `convert`.
2. **Choose its risk.** `risk` is one of `TOOL_RISKS` and defaults to `write`: `read` when it
   only reads, `write` for ordinary changes, `bulk-write` for many records in one call,
   `destructive` for deletes and anything that cannot be undone. The approval gate decides on
   it (`docs/adr/0018-invocation-pipeline-and-gate.md`), so never understate it.
3. **Make it a button** if the request says so: `recordAction` with `object`, `label`,
   `idInput`, and `confirm`, `ask` (one choice first) or `hideWhen` as needed. An output with
   `open: { object, id }` opens that record afterwards. See Leads: `convert`, `disqualify`.
4. **Write an automation** with `defineAutomation`: `label`, `description`, a `trigger`
   (`AutomationTrigger` lists every type; the README's "Triggers" table explains most),
   `conditions` on the trigger record when only some records should start a run, `steps` and
   `run`. Ship it turned off with `enabled: false` unless the request says otherwise (Leads).
5. **Declare every step and its intents.** A camelCase `name` each. A `do` step lists `reads`
   (objects), `writes` (`WriteIntent`: object, action, count, titles, assignee), `notifies`
   (recipient and the message as written) and `calls` (other operations, such as `query.sql`).
   Waits are `kind: "sleep"` or `"waitForEvent"`; a branch taken in code is `kind: "condition"`.
   The host draws the summary, the step diagram and the approval screen from these, never from
   the code. See Deals: `wonOnboarding` (every kind) and `stalledDeal` (`calls`).
6. **Grant what the steps need.** An object in `reads` needs `permissions.read`, one in `writes`
   needs `permissions.write` (own objects need neither); `notifies` needs `"notification.send"`
   in `permissions.operations`; every operation in `calls` goes in `permissions.operations`;
   `ctx.ops` needs `"ops"` in `modules`. An outside service is a gatekeeper: a `connections`
   entry and its module in `permissions.modules`. See Deals: `permissions` in `index.ts`.
7. **Write `run(event, step, ctx)`.** Call `step.do`, `step.sleep` and `step.waitForEvent` only
   with declared names of the matching kind, each once. Notify with `ctx.notify` inside the step
   that declares it. See Deals: `wonOnboarding.run`.
8. **Add a dashboard** typed `DashboardDeclaration`: `title`, `description`, `filters`, `widgets`
   (`home: true` on at most one, to make it the default Home). A filter's `id` names its SQL
   parameters (a dateRange `date` binds `:date_from` and `:date_to`; a user filter `owner` binds
   `:owner`); `:now`, `:today` and `:me` are always there. Each data widget is one read-only
   `SELECT` over the `rec_*` views (`rec_x_<id>_<object>`, columns in snake_case: `closedAt` is
   `closed_at`). `mapping` names the result columns the chart uses (`value` for a kpi, `x` and
   `y` for bar and line, `label` and `value` for donut and leaderboard, `columns` for a table).
   `clickThrough` opens exactly the records the widget counted: `{ object, filter }` with
   `{ $row: "<column>" }` and `{ $param: "<name>" }` placeholders; one that resolves to null drops
   its condition. See Leads: `leadsDashboard` (the smallest), then Deals: `salesOverview`.
9. **Test every tool and automation** in `test/` with `createTestHost(extension, { records,
   users, operations })` from `@composable-os/sdk/testing`. `host.runTool(name, input)` returns
   the output; pass `operations: { "query.sql": ... }` for operations it does not fake.
   `host.runAutomation(name, { record, period, ... })` runs it start to finish: assert
   `run.undeclared` is empty, then `run.steps`, `run.writes` and `run.notifications`. Test the
   case where the conditions do not hold too. See Deals: `test/automations.test.ts`.
10. **Check, fix, repeat** (last section), then run `pnpm lint`, `pnpm typecheck` and `pnpm test`
    at the repository root.

## The rules

- **No writes to the database.** Data is reached only through `ctx.ops.call`, so permissions,
  approval and audit apply to everything a tool or automation does.
- **No outside access except through a gatekeeper.** The sandbox has no network; a gatekeeper is
  where credentials, limits and review of outbound traffic live.
- **No change to identity or approval policy.** `extension.*`, `policy.*`, `user.*` and `audit.*`
  can never be granted, so code an AI may write cannot widen its own authority.
- **No hook on a write.** An automation reacts after a change commits and cannot veto it; a rule
  on writes is a behaviour in the host, so it holds for every actor.
- **No UI.** Tools, automations and dashboards are declared and the host renders them, so they
  keep working when the host changes.
- **A tool is not a transaction.** Each `ctx.ops.call` is its own operation, and a run can stop
  between two of them. Write the tool so it is safe to run again: find what an earlier run made
  before creating it, and set the "done" state last (Leads: `convert`).
- **An automation takes only the steps it declared.** An undeclared step name fails the run, and
  an undeclared write or notification is flagged; the declarations are what people approve.
- **Side effects go inside `step.do`.** `run` is replayed from the start on every resume, and
  only a `step.do` result is stored; a write outside it would happen again.
- **Tests are required.** At least one per tool and one per automation, with `createTestHost`,
  and every automation test asserts `run.undeclared` is empty.

**When something is missing.** If the work needs something the platform, the contract or this
skill does not have (a trigger, a gatekeeper, a core operation, a widget type), changing them is
part of the work, done properly, with an ADR where `AGENTS.md` asks for one and this skill
updated to match. Never fake it in extension code with a shortcut or a workaround (a rule enforced
in a tool, a write past an operation, a call past a gatekeeper). If the change is too large
for the request, say so and stop; do not ship the workaround.

## The check command

```bash
pnpm cos ext check extensions/<id>
```

```bash
pnpm cos ext test extensions/<id>
```

`check` reads issues in the format `write-extension` describes. Automation and dashboard issues
are `contract` issues, and their path is exact: `automations.<name>.steps.0.writes.0.object`
is the first write of the first step, and `dashboards.<name>.widgets.2.mapping` the third
widget's mapping. A missing permission names what to add, for example
`Step writes task: add "task" to permissions.write`, or
`Automation <name> notifies people: add "notification.send" to permissions.operations`. Add
the permission the step needs; do not drop the intent to silence it. The check validates a
dashboard's shape, not its SQL, which first runs when the dashboard is shown: keep each query
to the `rec_*` views and the parameters its filters bind.

`test` first refuses to run while a tool or automation is named in no test file
(`No test names automation <name>.`), then runs the extension's Vitest tests. Do not finish with
either command failing.
