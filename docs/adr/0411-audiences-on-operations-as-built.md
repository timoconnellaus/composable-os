# ADR 0411: Audiences on operations, as built

Status: accepted, 2026-11-20 (stage 22 build, step 2). Builds part of
[ADR 0402](0402-staff-and-customers.md).

## Context
ADR 0402 decided that every operation declares which of `staff`, `customer` and `public` may call
it, that the default is staff only, and that opening one is a reviewed change. The stage 22 spec
left open what a refused caller is told, whether a refusal is audited, and how the list of open
operations is produced and checked.

## Decision
- **`audiences` is a key of the operation definition** (`packages/core/src/audiences.ts`): a
  non-empty subset of `staff`, `customer`, `public`. Left out, it is `["staff"]`. A caller has
  exactly one audience, the kind of its principal.
- **The check is the first thing the pipeline does,** before the input is parsed. A caller the
  operation is not open to gets `UnknownOperationError`: the same class, code and words as a name
  that is not in the registry. Staff calling an operation for customers alone get it too.
- **A refusal by audience is not audited,** as a call to an unknown name is not. A caller outside
  the org could otherwise write one audit row per guess. Limits on such callers are the HTTP
  surface's and the rate limiter's (stage 22 step 7 and stage 23).
- **The risk floor is checked where a definition is checked** (`operationProblems`): by
  `defineOperation` when the module loads and by the registry when it is built. An operation open
  to `customer` or `public` with a risk class above `write` throws there, with a message. So does
  one marked `alwaysReview`, because a customer's call is never queued.
- **`packages/core/open-operations.json` is the generated list:** each open operation with its
  audiences and risk class, sorted by name. `test/open-operations.test.ts` fails when it and the
  registry differ, so `pnpm test` and CI do. `pnpm --filter @composable-os/core open-operations`
  rewrites it. The registry only loads in workerd, so the script runs that test and writes what
  it prints.
- **Staff surfaces list only what staff may call.** `listOperations` leaves out an operation
  that does not list `staff`, so MCP and the assistant never offer one.
- **Nothing is opened in this step.** The file's list is empty. Tests use fixture operations in a
  registry of their own, never in the core registry.

## Why
- One answer for "closed to you" and "does not exist" means the registry cannot be mapped by
  someone probing names, and a handler never has to think about it.
- Checking the floor at definition time makes a mistake fail at start-up and in every test run,
  not on the first call.
- A committed file makes the diff of a pull request say "this is now open to customers", which a
  key deep in an operation's definition does not.

## Consequences
- Extension tools become operations through `defineOperation` with no `audiences`, so they are
  staff only until the SDK gains the key (stage 22 step 6). When it does, tools of shipped
  extensions must appear in the generated list too, which today reads only the core registry.
- A staff member cannot call a customer-only operation to try it. Previewing as a customer is
  left out of stage 22.
- A fixture operation is never in the generated file. The spec's words "the generated list holds
  only a test fixture" are met by a fixture registry in the tests.
