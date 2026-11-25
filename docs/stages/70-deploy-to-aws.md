# Stage 70: Deploying to AWS

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Deployment), ADRs [0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0163](../adr/0163-deploy-engine-over-the-cloudflare-api.md),
[0210](../adr/0210-hosted-deployments-on-workers-for-platforms.md),
[0400](../adr/0400-a-general-host-and-products.md),
[0422](../adr/0422-client-repos-and-one-command-as-built.md),
[0450](../adr/0450-client-environments.md),
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md) and
[0611](../adr/0611-one-host-a-database-per-client.md); stages
[66](66-one-host-many-clients.md), [67](67-postgres.md), [68](68-host-on-node.md) and
[69](69-lambda-sandbox.md); `scripts/release/build-release.ts`, `packages/release/src`
(`install.ts`, `deploy.ts`, `update.ts`, `preflight.ts`, `attestation.ts`, `cloudflare.ts`),
`packages/create-composable-os/src/main.ts` and `client-repo.ts`,
`packages/product/src/index.ts`, `.github/workflows/release.yml` and `install-test.yml`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its end.

## Goal

A release can be put on AWS as it is put on Cloudflare. Anyone creates the infrastructure in their
own AWS account with an OpenTofu module that ships with the product, then runs `cos deploy`, which
migrates every client's schema and switches the host to the new release with no downtime. Every
store that holds data is in the region the deployment names. The first use is a health product
that must keep its data in Australia.

## What exists today (from the code)

- **A release is one tarball in Workers format.** `scripts/release/build-release.ts` bundles every
  Worker as `wrangler deploy --dry-run` would upload it, adds the app's static assets, the SQLite
  migrations, the client kit and `manifest.json`, and writes a byte-reproducible `tar.gz`, the
  manifest alone and `SHA256SUMS`. `release.yml` builds it twice and compares the hashes, attests
  build provenance, drafts the GitHub Release, runs `install-test.yml` on it and publishes.
- **Verification** (`attestation.ts`, `source.ts`): a deployment refuses files that do not match
  `SHA256SUMS` and a provenance attestation made by `release.yml` in the product's repository.
- **The deploy engine talks to the Cloudflare REST API** (ADR 0163; `cloudflare.ts`, 932 lines).
  `installRelease` finds or creates resources by name, applies migrations over D1's REST API,
  writes the deployment state and uploads the Workers. Every step looks before it changes, so a
  re-run converges.
- **The engine creates the infrastructure too:** D1, R2, KV, queues and Vectorize indexes are made
  by `provisionResources` (`deploy.ts`). There is no separate infrastructure step.
- **Deployment state is a row in the database** (`core_install`; `DeploymentState` in
  `deploy.ts`).
- **An update** (`runUpdate`, `update.ts`): pause automations, take a D1 bookmark, migrate,
  create resources the release adds, switch all Workers, smoke check `/api/health`, resume. A
  failure redeploys the previous bundle and restores the bookmark, so data written since is lost.
  `cos rollback` (`runRollback`) does the same on request. A self-updater runs the same update
  from inside the app (the `updater` port in `packages/core/src/operation.ts`).
- **Preflight** (`preflight.ts`) refuses a target that is not newer, an active extension on an
  unsupported contract, a database newer than the target, and a missing required secret.
- **The `cos` CLI** (`packages/create-composable-os/src/main.ts`): `install`, `upgrade`,
  `rollback`, `status`, `uninstall`, each over the Cloudflare API with a token. In a client repo,
  `deploy` (`client-repo.ts`) checks the org's extensions and the apps' types, verifies the
  release `product.ts` names, installs or upgrades the host, stores the org's extensions in the
  bucket, lists secrets a person must set and uploads the web app.
- **The product definition** (`packages/product/src/index.ts`): `ClientProductDefinition` has
  `platform`, `packs`, `web`, `mobile`, `environments`, `gatekeepers` and `location`, a Cloudflare
  location hint that the code itself calls "a preference, not a guarantee" (ADR 0580). It has no
  field for where the host runs.
- **The install test** (`install-test.yml`) installs release N in a test Cloudflare account,
  smoke tests it with Playwright, proves a failing migration rolls back with data restored,
  upgrades to N+1 and tears down. It skips cleanly when the account's secrets are not set.
- **Stage 66** specifies, for Cloudflare, a registry of clients, hostnames, settings and
  encrypted secrets in a D1 database only the operator writes. It is not built.
- **Not anywhere:** a container image, an AWS client, infrastructure as code, a Postgres
  migration runner, a target in the product definition. `.nvmrc` pins Node 24.

## Decided by the owner (2026-11-26)

| # | Decision |
| --- | --- |
| 1 | Two targets. AWS is Node in containers on ECS, RDS Postgres and S3. The region is a setting; the first use is ap-southeast-2 |
| 2 | A Postgres migration set beside the SQLite set |
| 7 | A schema per client in one Postgres database. No table gains a client column |
| 10 | Pack and extension code on AWS runs in a Lambda function with no network access |
| 11 | The AWS infrastructure ships as an OpenTofu module with the product, usable by us or anyone in their own AWS account. OpenTofu creates the infrastructure; `cos deploy` runs migrations and puts a release on it, as on Cloudflare |
| 13 | The whole host is wanted on AWS, in stages |
| 15 | The build starts after stage 66 lands |

## The design in one page

```
 release.yml ─► GitHub Release: Workers tarball (unchanged) + AWS tarball + image in the registry
                                        │ verified by cos (SHA256SUMS, provenance)
 person ─► tofu apply ─► the module ────┼──────────────────────────────────────────────┐
 person ─► cos deploy ──────────────────┘                                              ▼
   1 read the deployment's parameter   ┌───────────── one AWS region ───────────────────────┐
   2 copy the image into ECR           │ ALB + certificate + WAF ─► ECS: web  ·  ECS: worker │
   3 run the operator task: migrate    │        operator task (migrate, client commands)    │
   4 new task definitions, roll        │ RDS Postgres: registry + a schema per client       │
   5 sandbox function: new version     │ S3 files · Lambda sandbox (no network) · secrets   │
   6 smoke check, record               │ logs, alarms, backups                              │
                                       └────────────────────────────────────────────────────┘
```

- **OpenTofu owns what exists:** network, database, bucket, services, function, roles, keys.
- **`cos` owns what runs on it:** the image, the schemas, the clients, the release recorded.
- **Nothing reaches the database from outside the network.** Every `cos` command that touches
  data runs as a short task inside it.

## The model

### The AWS release

One version and one tag for both targets. The Workers tarball does not change by a byte. The
release gains:

- **A container image,** built from the same commit, holding the host as stage 68 builds it. One
  image runs as `web`, `worker` or `operator` by its command. It is pushed to the repository's
  container registry by digest, for `linux/arm64` and `linux/amd64`.
- **An AWS tarball,** `<prefix>-<version>-aws.tar.gz`, with its manifest beside it: the Postgres
  migrations (stage 67), the sandbox function's package (stage 69), the OpenTofu module and
  `manifest.json`. Built reproducibly and checked by building twice, as the Workers tarball is.
- **The AWS manifest** names the image by digest, the sandbox package by hash, each migration and
  whether it is additive (below), the secrets and settings the host reads, the extension contract
  and the module contract it needs.
- **Signing:** `SHA256SUMS` lists the new files; provenance is attested for the tarball, the
  manifest and the image (the image's attestation is pushed to the registry). `cos` verifies the
  manifest exactly as it verifies today's, and deploys the image only by the digest the verified
  manifest names. No new trust path.
- Whether two image builds give the same digest (a pinned base image, fixed timestamps) is
  checked in step 2. If they cannot, the manifest's digest is still what is attested and deployed.

### The OpenTofu module

`infra/aws` in this repository, shipped inside the AWS tarball and tagged with the release. A
root module in the operator's own repository pins it to a version. It creates:

| Part | What |
| --- | --- |
| Network | A VPC over two zones: public subnets (load balancer), private subnets (tasks, with one NAT gateway for calls out), isolated subnets (database, sandbox). An S3 gateway endpoint |
| Database | RDS Postgres 16 or later (stage 67), encrypted, in the isolated subnets, reachable only from the tasks, directly and with no pooler between (stage 68 holds a listening connection). Multi-AZ on by default. Automated backups with point-in-time restore. Deletion protection and a final snapshot |
| Files | One S3 bucket: no public access, encrypted, versioned, old versions removed after a set number of days |
| Host | An ECS cluster on Fargate with stage 68's two services, `web` and `worker`, and an `operator` task definition that never runs as a service |
| Sandbox | The Lambda function of stage 69, in subnets with no route out, with the rules stage 69 sets (it may reach the host's door and nothing else, names included), and a role that can do nothing but write its log |
| Entry | An application load balancer, HTTPS only, with ACM certificates for the deployment's domains, a health check on `/api/health`, and a WAF rule that limits requests per address |
| Secrets | Empty Secrets Manager entries under one prefix, and a KMS key for clients' given secrets and for stage 73's stored credentials |
| Watching | CloudWatch log groups with a retention period; alarms to one SNS topic: 5xx rate, unhealthy targets, tasks below the wanted count, database CPU, storage and connections, sandbox errors |
| Access | A task role and an execution role per process, and a `deployer` policy holding exactly what `cos` needs, usable by a person or by CI through GitHub's OIDC |

- **Inputs:** `name`, `region`, `domains`, `alarm_email`, and sizes with defaults: the Postgres
  version, database class and storage, Multi-AZ, backup days, task CPU, memory and count, log
  days, `nat` (one or one per zone).
- **Outputs:** the load balancer's address, the DNS records to add (certificate validation and
  the hostnames), and one SSM parameter, `/<name>/deployment`, holding everything `cos` needs: the
  cluster, services, task definition templates, function, bucket, repository, subnets, key, log
  groups and the module's contract number.
- **State:** an S3 bucket in the same region, versioned and encrypted, with a lock. The module
  never generates a secret value (the database's master password is managed by RDS), so the state
  holds none; CI checks a plan's state for sensitive values.
- **Versioning:** the module carries a contract number. A release's manifest says the lowest it
  runs on. `cos deploy` refuses infrastructure that is behind and names the `tofu apply` to run.
  A newer module always runs the release already deployed, so the order is: apply, then deploy.
- **Names:** every resource is named from `name`. `cos infra init` writes the root module and its
  variables file from `product.ts`, so the name is still written once.

### The target in the product definition

```ts
target?: { aws: { region: string; domains: string[] } }   // absent: Cloudflare, as today
```

On `ClientProductDefinition`. It is written at the first deploy and never changed: `cos deploy`
refuses when the deployment it finds is on the other target or in another region. `location` is
refused beside an AWS target. No account id is written anywhere: `cos` uses the credentials it is
given (the standard AWS chain) and finds the deployment by name and region. Each environment
(ADR 0450) is its own deployment with its own root module, named as on Cloudflare
(`<id>-staging`).

### What `cos` does on AWS

The AWS engine is a new package beside `packages/release`, used by the CLI only.

- **`cos deploy` / `cos install`:** verify the release; read `/<name>/deployment`; preflight;
  copy the image into the deployment's ECR repository by digest; run the operator task to
  migrate; register task definitions from the module's templates with the image filled in; roll
  both services; publish the sandbox function's new version and move its alias; smoke check;
  write the state. A re-run converges, as today.
- **Task definitions are shared work.** The module owns size, roles, network and logging in a
  template; `cos` owns the image and the list of secrets. A size changed by `tofu apply` takes
  effect at the next `cos deploy`.
- **Migrations** run in the operator task, first for the registry, then for each client's schema,
  each client's set in one transaction under that client's lock (stage 67). A failure rolls that
  client back exactly, with nothing lost, and the deploy stops before any service changes.
- **Zero downtime:** services roll with every old task kept until a new one is healthy. The old
  release therefore runs against the new schema for some minutes. So a Postgres migration is
  **additive** unless marked breaking: a lint refuses a drop, a rename or a tightened constraint
  without the mark. A release with a breaking migration takes a snapshot first and stops the
  services while it migrates.
- **`cos upgrade`** is the same procedure to a newer version. Preflight's checks are today's.
- **`cos rollback`** puts the previous release's image and sandbox package back. **It does not
  rewind the database:** the previous release runs on the newer schema, which additive migrations
  allow, and nothing written since is lost. It refuses to cross a breaking migration. Rewinding
  data is a restore (below), a person's decision.
- **`cos status`** reads AWS directly: the release recorded, each service's wanted and running
  tasks, target health, the database's state, the last backup and the last restore test.
  `--residency` prints the residency statement from the live account.
- **`cos uninstall`** empties what `cos` put there and tells the person to run `tofu destroy`.
  It never deletes infrastructure.
- **Deployment state** is an SSM parameter (`/<name>/release`): version, digests, the last runs.

### Clients and the registry

As stage 66 specifies, with these differences:

| Stage 66 on Cloudflare | On AWS |
| --- | --- |
| A Durable Object per client | A schema per client, `c_<id>`, in the one database |
| The registry is a D1 database of the host | The registry is the schema `cos_registry` in the same database |
| A single-client deployment has no registry | Every AWS deployment has the registry, with one client or many |
| Only `cos` with the account's token writes it | Only the operator task writes it: the host connects as a database role that can read the registry and write nothing in it |
| A bookmark per client, restored on failure | A transaction per client. Point-in-time restore is of the whole database |
| A location hint per client | The deployment's region |
| A client's web app in a namespace behind `cos-front` | Not in this stage (Out of scope) |

`cos client add`, `list`, `hostname`, `setting`, `secret set`, `export`, `import` and `remove`
each run the operator task. A client's export is its schema as a Postgres dump, its files and its
secrets; it imports into another AWS deployment. Hostnames are rows in the registry; the
certificate that covers them is the module's.

### Secrets

| Kind | Where | How it reaches the host |
| --- | --- | --- |
| The database's master password | Secrets Manager, managed and rotated by RDS | Read by the operator task only. The host's roles sign in with IAM database authentication |
| The master secret that every client's auth secrets are derived from (stage 66) | Secrets Manager, generated once by `cos` at the first install | Injected as an environment variable when a task starts |
| The operator's own (provider keys, gatekeepers' OAuth apps) | Secrets Manager, set by a person with `cos secret set` | The same |
| A client's given secrets | The registry, encrypted under the KMS key. `cos` encrypts on the person's machine, so the plain value is never in a task's parameters or a log | The host may decrypt; only the operator may encrypt |

The rule holds as follows. Auth secrets are still env-only: they are never in Postgres, the
image, the state or a log. ECS injects them with the execution role, and the host's own task role
cannot read Secrets Manager, so no code in the host can fetch a secret it was not started with.
Policy (the approval floor, the identity provider, sign-up) is in the registry, which the host
cannot write. Preflight refuses a deploy that names a required secret that has no value.

### What "first class" requires

- **Health:** the load balancer checks `/api/health` on every task; the smoke check is today's
  `healthSmoke`.
- **Backups tested by a restore:** `cos restore-test` restores the database to a moment into a
  temporary instance, checks every client's schema version and row counts against the live one,
  and deletes it. `cos status` shows the date of the last pass and warns after 45 days.
- **A real restore** is the module's: an input names the moment or snapshot, and `tofu apply`
  brings the database up from it. It rewinds every client.
- **Logs without personal data:** the host's request log holds method, route pattern, status,
  duration, client id and request id, never an address, a query string or a body. Postgres is set
  to log no statement parameters and terse errors. Load balancer access logs are off by default.
- **Erase** (ADR 0320) reaches a client's schema and file prefix at once. Old file versions and
  database backups age out after the periods the module sets; the statement says how long.
- **The residency statement.** Data at rest is held by: RDS and its backups and snapshots; the
  files bucket; CloudWatch Logs; Secrets Manager and the SSM parameters; ECR and Lambda (code
  only); the state bucket (no personal data). All are regional services created in `region`.
  Nothing is replicated to another region. IAM, DNS and certificates hold names only. Services
  outside AWS that a deployment turns on (stages 71 and 73) are listed by name.

### CI

- **In ordinary CI, no account:** `tofu validate` and the module's tests with mocked providers;
  the AWS engine against a fake of the AWS APIs, as the Cloudflare engine is tested.
- **`install-test-aws.yml`,** in a dedicated AWS account through GitHub's OIDC, skipped cleanly
  without it: `tofu apply` at the smallest sizes; install N; the Playwright smoke; a failing
  migration leaves N running and the data untouched; upgrade to N+1 while a loop of requests runs
  and none fails; `cos rollback`; `cos restore-test`; `tofu destroy`. A sweeper removes anything
  a failed run left.
- **When:** on every release, gating publication as the Cloudflare test does, and weekly.
- **Cost:** about an hour a run, most of it waiting for the database. Estimated at under US$2 a
  run and under US$20 a month; the first runs' bills replace the estimate.

## Out of scope

- **A client's own web app on AWS.** It reaches an AWS host over HTTPS with the typed client, as
  the mobile app does. Where its code runs, and what replaces the binding's trusted visitor
  address, is its own stage (question 3).
- The in-app self-updater on AWS. Settings shows the version; updates are `cos`.
- Moving a deployment or a client between Cloudflare and AWS.
- Restoring one client from a backup as a command (the procedure is documented).
- Usage per client beyond database and file size.
- A CDN, more than one region, Aurora, RDS Proxy, Kubernetes.
- Models, vectors, mail (stage 71), the assistant (72), connections (73), live screens (74).

## Acceptance criteria

1. A release carries the AWS tarball, manifest and image; all three are in `SHA256SUMS` or
   attested, and `cos` refuses a manifest or an image digest that does not verify.
2. The Workers tarball of a commit is byte-identical with and without the AWS build.
3. `tofu apply` in an empty account, then `cos install`, gives a host at its domain that passes
   the Playwright smoke, with no step in the AWS console.
4. `tofu plan` straight after `cos deploy` shows no change.
5. An upgrade under a loop of requests completes with no failed request.
6. A migration made to fail for one of three clients leaves that client's schema as it was, the
   services on the old release and the other two usable.
7. `cos rollback` returns to the previous release and keeps a record written after the upgrade.
8. `cos client add` makes a working client; a session for one client is refused at another's
   hostname; the host's database role cannot write the registry (tested by trying).
9. No secret value is in the state, the image, a task definition, a log or Postgres in the clear.
10. `cos restore-test` passes, and fails when a table is dropped from the restored copy.
11. After the smoke journeys, no log group contains the seeded person's name, email or address.
12. `cos status --residency` lists every store with its region and fails if one is elsewhere.
13. `install-test-aws.yml` passes on a release and leaves the account empty.
14. `docs/deploying.md`, `docs/architecture.md`, `CONTEXT.md` and the `start-client-app` skill
    say what is now true; `apps/marketing/SITE.md` is checked against it.

## Dependencies

Stages 67, 68 and 69 (so stage 66 before them). An AWS account for the install test and a domain
whose DNS a person can edit. This spec assumes stage 67 gives a database handle opened on a named
schema with the client's lock, and stage 68 gives the host a client's environment read from the
registry through an interface; this stage builds the registry's tables and commands behind it.

## Migrations and numbers

No SQLite migration. The registry's Postgres migrations are their own set beside the host's. The
first build step claims a block for its ADRs in [`docs/parallel-work.md`](../parallel-work.md).

## Suggested build order

1. **Spike in a real account:** a hand-written module (network, database, one service, the load
   balancer) running a placeholder image and one operator task. Record the time to create and to
   deploy, a month's cost at the smallest live sizes, and each fact marked below as to confirm.
2. **The AWS release:** the image, the AWS tarball and manifest, attestations, in `release.yml`.
3. **The module,** complete, with its tests and its outputs.
4. **The target in `product.ts`, `cos infra init` and the AWS engine:** locate, preflight, copy,
   operator task, switch, smoke, state; `cos deploy` and `cos install` against fakes.
5. **The registry on Postgres** and the `cos client` commands; migrations for every client.
6. **Upgrade, rollback, status and uninstall;** additive and breaking migrations and the lint.
7. **Secrets:** the master secret, the KMS key, `cos secret set`, the roles.
8. **Operations:** the log rule and its test, alarms, `cos restore-test`, the residency report.
9. **`install-test-aws.yml`,** wired into the release.
10. **Export, import and remove a client.**
11. **Docs, the skill and the site.**

Steps 2 and 3 can run side by side; 5 and 7 after 4.

To confirm in step 1: the Postgres version RDS offers in the region; that IAM database
authentication works with the driver's pool; how many certificates one listener takes; that
Lambda in an isolated subnet starts within stage 69's budget; OpenTofu's S3 state lock; prices.

## Decided by this spec, open to override

- **One release, two sets of files.** The Workers tarball is untouched.
- **ECS pulls only from ECR in the region,** never from the public registry at run time.
- **Every AWS deployment has the registry,** even with one client: one shape, not two.
- **One database role for the host and one for the operator,** not a role per client.
- **`cos` never runs `tofu` and never creates infrastructure.** No secret is in the state.
- **Rollback is of code, not data,** and migrations are additive by default.
- **Operator commands are tasks inside the network,** not a public admin endpoint.
- **Certificates are the module's;** a client's own domain is added to `domains` and applied.
- **Fargate, one NAT gateway, Multi-AZ on for live.** No CDN: the load balancer is the only way in.
- **The AWS SDK,** not a hand-written client. **One target** for every environment of a product.

## Questions for the owner

1. **Whose AWS account holds the first product: ours, or the company's own?** Recommended: its
   own account, created for it, with us as the operator. A health product's data is then in an
   account its owner controls, and leaving needs no move.
2. **Is losing the whole region an accepted risk at first?** Multi-AZ covers a data centre.
   Copying backups to Melbourne (ap-southeast-4) would keep data in Australia and cover Sydney,
   at more cost and a second region in the residency statement. Recommended: accept the risk now,
   say so in the statement, and add the copy when a client asks for it.
3. **Does the first AWS product need its own web app at launch, and may that run on Cloudflare?**
   A web app on Cloudflare keeps nothing but every request passes through it. Recommended: launch
   with the staff app and the mobile app, and give the web app on AWS its own stage, because a
   residency promise is simplest when nothing of the product runs outside the region.
4. **The smallest live shape is estimated at US$150 to US$250 a month before use** (database in
   two zones, load balancer, NAT gateway, a few small tasks), and staging about half. Is that
   floor acceptable? Recommended: yes for live; staging in one zone. Step 1 replaces the estimate.

## Status

Spec proposed (2026-11-26). No build step is built yet.

- **Step 1** — not built — needs: stage 68, an AWS test account — Spike in a real account: time, cost and the facts to confirm

- **Step 2** — not built — needs: step 1, stage 69 — The AWS release: image, tarball, manifest, attestations

- **Step 3** — not built — needs: step 1, stage 69 — The OpenTofu module, complete, with tests and outputs

- **Step 4** — not built — needs: step 2, step 3 — The target in `product.ts`, `cos infra init` and the AWS engine

- **Step 5** — not built — needs: step 4 — The registry on Postgres and the `cos client` commands

- **Step 6** — not built — needs: step 4 — Upgrade, rollback, status, uninstall; additive and breaking migrations

- **Step 7** — not built — needs: step 4 — Secrets: master secret, KMS key, `cos secret set`, roles

- **Step 8** — not built — needs: step 5, step 6, step 7 — Operations: logs, alarms, restore test, residency report

- **Step 9** — not built — needs: step 8, an AWS test account — `install-test-aws.yml`, wired into the release

- **Step 10** — not built — needs: step 5 — Export, import and remove a client

- **Step 11** — not built — needs: step 9, step 10 — Docs, the skill and the site
