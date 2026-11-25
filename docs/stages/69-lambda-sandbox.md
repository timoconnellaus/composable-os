# Stage 69: Pack and extension code in a Lambda sandbox

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0006](../adr/0006-dynamic-runtime-cloudflare-computer.md),
[0025](../adr/0025-extension-authority-and-runtime.md),
[0040](../adr/0040-extension-runtime-build.md), [0042](../adr/0042-code-mode.md) and
[0043](../adr/0043-extension-executor-and-stable-loader-ids.md); the spike
[`docs/spikes/0001-dynamic-runtime.md`](../spikes/0001-dynamic-runtime.md); stages
[66](66-one-host-many-clients.md) and [68](68-host-on-node.md) (the Sandbox port and the local
sandbox); `apps/runner/src/executor/executor.ts`, `host.ts`, `worker-code.ts`, `build-cache.ts`,
`code-gate.ts`, `apps/runner/src/extensions/code-mode.ts`, `producers.ts`, `runs.ts`,
`apps/runner/src/checker/entry.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its end.

## Goal

On AWS, pack and extension code runs in a Lambda function that has no network but a door to the
host, one invocation per run, under the same contract as on Cloudflare: the same built modules,
the same host modules, the same limits, the same run history and quarantine. A pack author
writes one extension and cannot tell which target runs it. The stage starts with a spike that
measures whether Lambda is fast enough; nothing else is built until it passes.

## What exists today (from the code)

- **What runs in a sandbox.** Tools, automation steps and manifest evaluation of every extension,
  shipped packs included (14 in `packs/`; there is no trusted fast path, ADR 0025); saved A2UI
  producers; Code Mode scripts; and the TypeScript checker.
- **What is loaded** (`worker-code.ts`). A fixed entry module, the SDK bundle (a text module of
  about 470 KB) and the extension's built modules under `ext/`. A build is a sucrase transpile
  with import rules plus a type check, cached by content hash (`build-cache.ts`).
- **Stable ids** (ADR 0043). Repeat code comes from `LOADER.get(id, …)`, whose callback supplies
  the code only when no isolate with that id is loaded. A tool worker's id hashes the extension,
  commit, host-module set and runtime; a manifest worker's hashes the source; the checker's
  hashes the compiler. Only Code Mode uses `LOADER.load()`, new code every time.
- **No authority in the worker.** `globalOutbound: null` and `env: {}`. Everything about a run
  travels as arguments: the request, and `RunHost` (`host.ts`), a per-run RPC object whose
  `call(module, method, args)` is the only way out.
- **Host modules:** `ops`, `storage`, `log`, `ai`, `routine-mail` and one `codemode:<gatekeeper>`
  each. `RunHost` answers only the declared ones, acts as the extension's principal (or the
  caller's for Code Mode), and collects the run's logs (at most 200) and operations.
- **Limits.** 30 seconds for a tool and for Code Mode, 10 for a manifest, as a timer raced
  against the call, with `limits.cpuMs` set to the same number. Code Mode: 100 host calls, a
  256 KB result, one script per user at a time (`CodeModeGate`), a rate limit per user.
- **Cancellation.** There is none of the code itself. On a timeout the host stops waiting,
  closes `RunHost` (every later call is refused) and drops the stub.
- **Reuse.** Runs of one id share a warm isolate and its module state, concurrently. Run state
  is only in `RunHost`. Stage 66 keeps ids free of the client.
- **Run history and quarantine.** Every run is a `core_extension_runs` row with its duration,
  outcome, logs and operations (`runs.ts`). Three consecutive failures that are the code's doing
  quarantine the extension (`QUARANTINE_AFTER`, `CALLER_ERRORS` in `executor.ts`).
- **Measured, on the local Workers runtime only:** a warm tool run 55 ms, 20 concurrent runs in
  82 ms (ADR 0043), a cold start around 10 ms (spike 0001). ADR 0006 asked for the numbers on a
  deployed runner; they are not recorded.

## Decided by the owner (2026-11-26)

1. On AWS the sandbox for pack and extension code is a Lambda function with no network access,
   one call per run.
2. Cold-start latency is measured in a spike before the build depends on it.
3. The AWS infrastructure ships as an OpenTofu module usable in anyone's account.
4. The reason for the target is a health product that must keep its data in Australia.

## The design in one page

```
   host task (web or worker)                         sandbox function (one, generic)
 ┌────────────────────────────┐   Invoke, one per run   ┌──────────────────────────────┐
 │ Executor ─ Sandbox port ───┼────────────────────────►│ fixed entry + SDK (packaged) │
 │   RunHost (this run only)  │   { key, run, token,     │ the extension's modules,     │
 │   sandbox door :port ◄─────┼──── host address }       │ fetched once when cold       │
 └────────────────────────────┘   host calls, HTTP,      └──────────────────────────────┘
        only this address         with the run's token     subnets with no route out
```

- **One function.** Its package is our entry and the SDK. Extension code is never deployed to
  AWS as a function: it arrives as data.
- **The host invokes it once per run** and waits. Host modules are HTTP calls from the function
  back to the task that invoked it, carrying a token that is that run and nothing else.
- **A warm environment is reused only for the same key,** by Lambda's tenant isolation mode.
- **The boundary is the function's microVM and its network rules.** Nothing inside the function
  is trusted to enforce anything.

## The model

### Reaching the host from a function with no network

A Lambda function outside a VPC can reach the internet, so "no network" means a function in
subnets with no route out. The question is how host calls cross.

| Option | How | For | Against |
| --- | --- | --- | --- |
| A. A door to the host | The function's security group allows one destination: the host tasks' sandbox port. Calls carry a per-run token | A run is one invocation; a host call is one awaited round trip, as now | The function has a network path, to one port. The rule is configuration we ship |
| B. Calls carried by the invocation | The function returns "I need this call"; the host makes it and invokes again with the answers so far; the code re-runs from the top | No network path at all | Tools must be replayable, which they are not written to be; cost grows with the square of the calls; many invocations per run, against decision 1 |
| C. A stream | Lambda can stream a response out | | It cannot take answers in during an invocation |

**Chosen: A.**

- **The door** is a second listener on each host task, apart from the public one. It accepts
  `POST` of `{ module, method, args }` for a run, and a `GET` of the run's modules. It answers
  only a request whose token names a live `RunHost` in that process. It has no other route.
- **The token** is random, made per run, held in memory beside the `RunHost`, and dead when the
  run ends or passes its deadline. The extension's code can read it, since it shares a process
  with our entry. That gives it nothing: the token allows exactly what that run may do.
- **The address** in the invocation is the invoking task's own, because the `RunHost` is in that
  task's memory. No load balancer sits between.
- **Names.** Security groups do not filter queries to the VPC's own resolver, so a function with
  no route could still leak through DNS lookups. The module blocks every name for the sandbox
  subnets (Route 53 Resolver DNS Firewall), and the door is reached by address. To be confirmed
  in the spike, from inside the function.
- **The function's role** can write its logs and nothing else. Its credentials are visible to
  the code and reach no AWS endpoint, since none is routed.
- **Plain HTTP** on this hop, inside private subnets, with a token that dies with the run.

### Getting code into the function

| Option | For | Against |
| --- | --- | --- |
| One generic function, code as data | The host needs only permission to invoke one function; Code Mode and unsaved source work the same way | A warm environment could serve another extension or client next, unless reuse is tied to the code |
| A function per extension version | Reuse is tied to the code by construction | The host, or the deploy, must be able to create functions, which is the power to create one with a network; seconds to create; no answer for Code Mode or unsaved source |

**Chosen: one generic function, with reuse tied to a key by Lambda's tenant isolation mode.**
A function created in that mode takes a tenant id on each invocation and never reuses an
execution environment across tenant ids. We pass the sandbox key as the tenant id.

- **The key** is today's stable id with the client added: client, extension, commit, host-module
  set, runtime. So `LOADER.get(id)` on Cloudflare and "invoke with this key" on AWS mean the
  same thing: maybe warm, same code.
- **Code when cold.** The entry keeps the modules it has loaded. With none, it fetches the run's
  modules from the door once, writes them under `/tmp` and imports them. This is `LOADER.get`'s
  callback. A warm run sends no code.
- **Throwaway code** (Code Mode, a manifest of unsaved source) uses a random key and carries its
  modules in the invocation. It is always a cold start, as `load()` is.
- **One run at a time per environment.** Lambda gives each concurrent invocation its own
  environment, so two runs never share a process, where on Cloudflare they may share an isolate.
  A burst therefore means cold starts. Module state still survives between runs of one key, and
  ADR 0043's rule for authors (keep nothing per call in module scope) stands.
- **Not verified:** that tenant isolation mode works for a function in a VPC, how many tenant
  ids a function may see, how long an idle environment is kept, and whether provisioned
  concurrency can be combined with it. Each is a line in the spike.

### The same contract inside

Lambda's Node has what the Workers sandbox does not: `process`, a filesystem, `fetch`. The
network rules make them harmless. The entry still narrows them, so that a pack cannot come to
depend on one target:

- `fetch` and `connect` throw at once, as they do with `globalOutbound: null`. Without this a
  call would hang until the run's timeout.
- Node's globals are taken away from extension modules as far as is cheap. This is for parity,
  and the spec does not count it as protection.
- `console` output from extension code is dropped, or captured for Code Mode as now. The only
  logs a run has are those it wrote through `codemode:log`.
- **A conformance suite** of small extensions (a host call, an undeclared module, a network
  attempt, a timeout, a crash, a large result, module state) runs against Worker Loader, the
  local sandbox and the deployed function, and must give the same results.

### Limits, cancellation, logs and the tail of a run

- **Time.** The host races its own timer against the invocation, with today's numbers. Lambda
  has no CPU-time limit, only wall time and memory, so `cpuMs` has no twin; it equals the
  timeout today, so nothing is lost.
- **Cancellation.** As now, the host stops waiting and closes `RunHost`, so the token is dead and
  the run can do nothing more. We know of no way to stop an invocation in flight (to be
  confirmed). The function's own timeout, the longest limit plus a margin, is the hard stop, and
  Lambda then discards the environment.
- **Memory** is a setting of the function, chosen in the spike. Running out is a crash.
- **Concurrency** is capped by the function's reserved concurrency. A throttled invocation is
  retried briefly, then fails as `rate_limited`, which does not count towards quarantine.
- **Errors.** A timeout and a crash map to today's `timeout` and `crashed`. Run history, the
  failure counter and quarantine are code above the port and do not change.
- **The tail.** Each invocation asks Lambda for the end of its log. From it the host keeps
  numbers only: cold or warm, initialisation time, duration, peak memory, stored on the run's
  row. The text is not stored, since a crash can quote record content (ADR 0320).
- **The function's log group** holds our entry's lines only (key, run id, timings), kept 14 days.

### The type checker and manifest evaluation

- **Manifest evaluation runs extension code,** so it runs in the function: no host modules, no
  door needed, keyed by the source hash as today. New source is a cold start.
- **The type checker is our code reading text,** not running it. On Node it runs in a worker
  thread of the host with a time and memory limit, loaded on first use, so the 3.5 MB compiler is
  out of the request thread as ADR 0043 wanted. The Sandbox port's checker method is implemented
  that way on Node. The alternative is a second key in the function.
- **Builds** (sucrase and the import rules) run in the host, as now.

### Local development and tests

The same entry runs in the local sandbox of stage 68: a child process per key, speaking the same
invocation and door. It has no network rules and is refused outside development and tests. The
network boundary can only be proved deployed, so criterion 3 runs in an AWS account.

### The security statement

- **On Cloudflare:** extension code runs in a V8 isolate that Worker Loader creates, with no
  network and no bindings. It can call the per-run host object it was handed and nothing else.
  The boundary is the isolate and the Workers runtime's sandbox, the one that keeps Cloudflare's
  customers apart.
- **On AWS:** extension code runs in a Lambda execution environment, a microVM, in subnets with
  no route to the internet or to AWS's services and no name resolution. It can open a connection
  to the host's sandbox port and nowhere else, and that port answers only the token of a run in
  progress. The boundary is the microVM and those network rules.
- **The differences, plainly.** On AWS part of the boundary is configuration in our OpenTofu
  module, and a wrong rule weakens it; a check that runs from inside the function is how a
  deployment proves it. On AWS the code has a general-purpose runtime inside its box, where on
  Cloudflare it has almost nothing. On AWS no two runs share a process, and no two clients share
  an environment.
- **The same on both:** what the code may do is decided in the host, by `RunHost`, per run.

## Out of scope

- The function's place in the OpenTofu module, its subnets and rules as shipped, and running the
  boundary check on every deploy: stage [70](70-deploy-to-aws.md). This stage writes the check
  and a throwaway configuration for the spike.
- What `codemode:ai` and `codemode:<gatekeeper>` reach: stages
  [71](71-models-vectors-mail-on-aws.md) and [73](73-connections-on-aws.md). Until then they
  answer "not configured" on AWS.
- Any change to the executor on Cloudflare beyond calling the Sandbox port.
- A warm pool or provisioned concurrency, unless the spike shows they are needed.
- A client's own Worker-shaped code (stage 66's namespace): not extension code.

## Acceptance criteria

1. The spike's numbers and its verdict against the pass mark are recorded in this spec.
2. The conformance suite gives the same results on Worker Loader, the local sandbox and the
   deployed function.
3. From inside the deployed function, each of these fails: a connection to a public address, a
   lookup of a public name, a call to an AWS endpoint with the role's credentials, a connection
   to the host's public port, and a call to the door with no token, an ended run's token and
   another run's token.
4. A pack's tool, an automation started by a record change, a manifest evaluation, a Code Mode
   script and a saved producer each run on the Node host through the function, and their run
   rows match Cloudflare's for the same input, timings aside.
5. A tool that loops forever ends as `timeout` at its limit, can make no host call afterwards,
   and three in a row quarantine its extension.
6. Two runs with different keys never execute in one environment, shown by a marker each leaves
   in module scope and in `/tmp`.
7. The host's role can invoke the one function and cannot create or change any.
8. The type checker gives the same issues on both targets for the SDK's test extensions.
9. `docs/architecture.md`, `CONTEXT.md` and a new ADR carry the security statement, and ADRs
   0025 and 0043 are amended with a dated note.

## Dependencies

Stage [68](68-host-on-node.md): the Sandbox port, the local sandbox, the Node host. An AWS
account for the spike, in ap-southeast-2. The AWS SDK's Lambda client.

## Migrations and numbers

The build step that needs them claims a block in [`docs/parallel-work.md`](../parallel-work.md)
for the ADR and for one migration in each set: columns on `core_extension_runs` for cold or
warm, initialisation time and peak memory, left empty on Cloudflare.

## Suggested build order

1. **The spike.** A hand-made function and a stub host on a container in one VPC, created by a
   throwaway OpenTofu configuration. It measures, cold and warm, 200 samples each, at the median
   and the 95th percentile:
   - a tool call that makes one `ops` call, from the host's request to its answer;
   - an automation started by a record change, from the commit to its first step finished;
   - a manifest evaluation of new source, and all 14 packs installed on a fresh client;
   - 20 tool calls at once;
   - and it answers each "not verified" above and runs criterion 3's checks by hand.

   **Pass mark** (question 2): the sandbox adds at most 100 ms to a warm tool call and 1.5
   seconds to a cold one at the 95th percentile, and a record-change automation's first step
   finishes within 5 seconds cold. **If it fails or tenant isolation mode does not fit:** stop
   and return to the owner with the numbers. The fallbacks to bring are provisioned concurrency
   for the keys customers wait on; a function per shipped pack version created by the deploy,
   never by the host; and, last, a sandbox service of our own in a container, which is a
   different security statement.
2. **The entry for Node** (`apps/sandbox`): loading modules, host-module proxies over the door,
   the narrowed globals. It runs in the local sandbox. The conformance suite, on Worker Loader
   and locally.
3. **The door and the Lambda implementation of the port:** tokens, the listener, invoke by key,
   code when cold, error mapping, the tail. Criteria 4 and 7.
4. **Throwaway code and the checker:** Code Mode, manifests of unsaved source, producers; the
   type checker in a worker thread. Criterion 8.
5. **Limits and failure:** timeouts, throttling, memory, quarantine parity. Criteria 5 and 6.
6. **The boundary check** as a script a deployment can run, and the suite against the deployed
   function. Criteria 2 and 3.
7. Docs, the ADR and the amendments. Criterion 9.

## Decided by this spec, open to override

- **Host calls go through a door on the invoking task,** with a per-run token (option A).
- **One generic function; the host never creates functions.**
- **Reuse is tied to the sandbox key by tenant isolation mode,** if the spike confirms it.
- **The type checker runs in the host on Node,** in a worker thread.
- **Plain HTTP on the door.** TLS there is a setting to add if a reviewer asks for it.
- **`fetch` throws at once inside the function,** for parity.
- **Only numbers are kept from a run's tail.**
- **The function runs the Node version the host does,** if Lambda offers it; else the nearest.

## Questions for the owner

1. **May a warm sandbox be shared by two clients running the same pack version?** Stage 66 said
   yes for Cloudflare: the code is the same and nothing of a client is meant to stay in it.
   **Recommended: no on AWS; the key includes the client.** Nothing stops a pack keeping a
   client's data in module scope, and for health data "meant to" is not enough. The cost is more
   cold starts, one per client and pack after a quiet period, which the spike measures. The
   same question for Cloudflare is not reopened here.
2. **What wait is acceptable?** The pass mark above is this spec's guess: 100 ms more on a warm
   tool call, 1.5 seconds on the first call after a quiet period, 5 seconds for an automation's
   first step. A customer starting an order calls a pack's tool, so the cold figure is felt at a
   checkout. **Recommended: accept these,** and pay for provisioned concurrency only if the
   spike shows checkouts meeting cold starts often.
3. **Is a network path to one port "no network access"?** Decision 1's words are stricter than
   option A. The only design with no path at all (option B) needs tools rewritten to be
   replayable. **Recommended: accept option A,** with criterion 3 as its proof on every
   deployment.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 68 — The spike: cold and warm latency, tenant isolation, the network checks

- **Step 2** — not built — needs: step 1 — The entry for Node and the conformance suite

- **Step 3** — not built — needs: step 2 — The door and the Lambda implementation of the port

- **Step 4** — not built — needs: step 3 — Throwaway code and the checker

- **Step 5** — not built — needs: step 3 — Limits and failure

- **Step 6** — not built — needs: step 4, step 5 — The boundary check and the suite against the deployed function

- **Step 7** — not built — needs: step 6 — Docs, the ADR and the amendments
