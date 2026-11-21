# ADR 0418: The typed client, its generator and pack hooks, as built

Status: accepted, 2026-11-21 (stage 23 build, steps 3, 4 and 7). Builds part of
[ADR 0403](0403-http-surface-and-typed-client.md) on [ADR 0417](0417-the-api-contract-and-versions.md).

## Context
ADR 0403 decided a small runtime package with no DOM or Node dependency, a generator that writes
each product's typed operations from that product's own registry in the client repo, an output
split by audience, and pack hooks over the client. The spec added TanStack Query factories with
one key rule, mutations that keep their idempotency key across retries, and tests under a Workers
and a React Native (Hermes) target.

## Decision
- **`@composable-os/client`** (`packages/client`) is the runtime: `createClient(specs, options)`
  with `call`, `query` and `mutation`, `ApiError`, `UpgradeRequiredError`, `NetworkError`,
  `invalidateFromMeta`, and `tokenSession` for native apps (ADR 0419). Its tsconfig has only the
  ECMAScript library and no platform types, so a use of `window`, `process` or a Workers API does
  not compile. The transport is any `fetch`-shaped function: the global `fetch`, React Native's,
  or a Worker's service binding.
- **TanStack Query without importing it.** `query(name, input)` returns `{ queryKey, queryFn }`
  with the key `[name, input]`; `mutation(name)` returns `{ mutationKey: [name], mutationFn,
  meta: { invalidates } }`. Any version of TanStack Query takes these objects;
  `invalidateFromMeta(queryClient)` in a `MutationCache` invalidates what a mutation lists.
- **Idempotency keys:** a mutation makes one key per call (crypto.randomUUID, or a `randomKey`
  the app passes; React Native has no `crypto` without a polyfill). The client retries a network
  failure, 429, 503, 504 and an in-flight key with the same key, twice by default. Its
  `mutationFn` keeps one key per variables object, which TanStack Query passes back on each of
  its own retries.
- **`cos client generate`** (`packages/client-gen`, served by the cos CLI as `cos client`):
  `--out <dir> [--product <id>] [--extension <dir>]...`. It reads the product's own registry: the
  platform's operations, the tools of the extensions the product names (its packs, from
  `extensions/<id>`), and any extension directory given (the org's own), loaded with esbuild. It
  writes `customer.ts` (customer and public operations) and `staff.ts`, each with its operation
  types from the JSON Schema, a table of specs, and a `create<Audience>Client` factory. The output
  imports only `@composable-os/client` and is committed in the client repo.
- **The audience split** is two files that do not import each other: a customer app imports
  `customer.ts`, and its bundle holds no staff operation's name.
- **Pack hooks:** a pack may ship a headless entry, `<package>/headless`: functions and hooks
  over the typed client, no markup. It types the operations it calls from its tools' own schemas,
  takes the client as an argument (a structural interface the generated client fits), and builds
  hooks from the app's own `useQuery`, importing neither React nor TanStack Query. Deals ships
  the example (`extensions/deals/headless.ts`); the convention is in the
  add-automations-tools-dashboards skill.

## Tests
- Types: a fixture app compiles against its generated client and fails `tsc` once an operation's
  input changes and the client is generated again (`packages/client-gen/test/generate.test.ts`).
- Per product: an extension's tool is typed only in a product that has the extension; the CLI
  includes the product's packs and an `--extension`.
- Bundle: the built customer entry point contains no staff operation name.
- Targets: the runtime and a generated client run in workerd (`packages/client` tests, with a
  generated fixture client the generator's test keeps current), and the same generated client
  bundled to ES2019 runs in a V8 context with only ECMAScript's globals, `fetch` and
  `setTimeout`. A real Hermes binary runs it when `HERMES_BIN` is set.
- Against the real surface: a write whose answer was lost is retried with its key and applied
  once; an app built for a version no longer served gets `UpgradeRequiredError`
  (`packages/core/test/http-client.test.ts`).

## Consequences
- The React Native target is a stand-in for Hermes unless `HERMES_BIN` is set: it checks the
  syntax level and the absence of host globals, not Hermes's own engine.
- The generator lives in this repository; a client repo (stage 24) runs it from the installed
  CLI with its own product and extensions.
