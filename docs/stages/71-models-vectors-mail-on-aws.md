# Stage 71: Models, search by meaning and mail on AWS

Read first: [`AGENTS.md`](../../AGENTS.md), ADRs
[0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0151](../adr/0151-provider-keys-as-workers-secrets-or-byok.md),
[0320](../adr/0320-erase-reaches-every-store.md) and
[0330](../adr/0330-self-hosted-workers-ai-over-rest.md); stages [67](67-postgres.md),
[68](68-host-on-node.md), [70](70-deploy-to-aws.md) and [73](73-connections-on-aws.md);
`packages/core/src/ai/client.ts`, `roles.ts`, `vectors.ts`, `embedding.ts`, `hybrid.ts`,
`usage.ts` and `admin.ts`, `apps/app/src/server/ai.ts`,
`packages/gatekeeper-email-send/src/transport.ts` and `worker.ts`,
`packages/core/src/customers/sign-in-mail.ts`, `packages/core/src/records/stream.ts`,
`packages/core/src/intake/runtime.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its end.

## Goal

On AWS the host's model calls go to Bedrock in the deployment's region, search by meaning uses
pgvector in each client's schema, and the host's mail goes out through SES. Code still asks for a
role and never a model id. Each small Cloudflare service the host calls is either given a
counterpart or named as one a deployment may leave on.

## What exists today (from the code)

- **Roles** (`packages/core/src/ai/roles.ts`): twelve roles (`build`, `assistant.core`,
  `assistant.subagent`, `summarise`, `extract`, `classify`, `embed`, `vision`, `review`,
  `dictation.cleanup`, and the speech roles `transcribe` and `speak`). A role resolves through
  three layers: shipped defaults (`SHIPPED_ROLES`), deploy config (`AI_MODEL_ROLES`), admin
  overrides in the database (`resolveRoles`). Each choice is checked against what the role needs:
  tool use, JSON schema, context size, vision, embedding size (`capabilityProblems`).
- **Every shipped text default is a Workers AI model** (`@cf/...`). The speech roles default to
  AssemblyAI. Providers are a fixed list (`PROVIDERS`): Workers AI, Platform AI, OpenAI, Google,
  OpenRouter, DeepSeek, Anthropic, an OpenAI-compatible endpoint, a custom provider, AssemblyAI.
- **The client** (`client.ts`) builds each provider with the Vercel AI SDK: Workers AI over REST
  through the deployment's AI Gateway (ADR 0330) or the `AI` binding; other providers through the
  gateway's unified endpoint, or directly with a key from a Worker secret.
- **AI Gateway does four jobs:** one endpoint for every provider, usage and spend per role from
  its logs (`admin.ts`), stored provider keys (ADR 0151), and payload logging switched off on
  every call (ADR 0320). About 25 source files name it.
- **Usage can already be counted without a gateway:** `usage.ts` adds up tokens per day, role
  and provider from the client's own report, for hosted deployments.
- **Settings, AI sets a provider key through the Cloudflare API** (`cloudflareAiAdmin`), as a
  Worker secret.
- **Vectors** (`vectors.ts`): core uses the port `VectorStore` (`upsert`, `deleteByIds`, `query`
  with an object filter, `getVector`). `vectorizeStore` adapts the Vectorize binding, whose shape
  is `VectorizeLike`; `memoryVectorStore` serves tests. The adapter is chosen in
  `apps/app/src/server/ai.ts` and `apps/runner/src/extensions/embeddings.ts`.
- **The index** `cos-records` has 384 dimensions (`VECTORIZE_DIMENSIONS`), cosine, from
  `@cf/baai/bge-small-en-v1.5`. A model of another size is refused when configured.
- **Embedding bookkeeping is in the database** (`core_embedding`, `core_embedding_queue`,
  migration 0150). The embed model's id is part of each record's text hash, so changing the model
  re-embeds everything once (`embedding.ts`).
- **Hybrid search** (`hybrid.ts`) merges text and vector results; with no vector store the
  ranking is the text one.
- **Mail out:** the `email-send` gatekeeper hands an approved message to `EmailTransport`
  (`transport.ts`): `send(OutgoingEmail)` returning a message id. Today that is Cloudflare Email
  Service's `send_email` binding. Its error codes decide whether a message was refused before
  sending or its outcome is unknown. Allowed sender addresses are set on the binding at deploy.
- **The host's own mail** (sign-in codes, invites) goes through the same gatekeeper, as a kind a
  human admin must let through (`sign-in-mail.ts`, `HostMail` in `packages/core/src/invites.ts`).
  The gatekeeper is a `WorkerEntrypoint` with a Durable Object.
- **Mail in** is an Email Worker `email()` handler in `packages/gatekeeper-email/src/email.ts`.
- **Video** is Cloudflare Stream behind `VideoHost` (`stream.ts`), called over HTTPS with a token
  and a signing key. Playback is from `customer-<code>.cloudflarestream.com`.
- **Public forms** check a Turnstile token against Cloudflare (`intake/runtime.ts`); without the
  secret a public form answers nothing.
- **Not anywhere:** a Bedrock provider, pgvector, an SES transport.

## Decided by the owner (2026-11-26)

| # | Decision |
| --- | --- |
| 1 | Two targets; on AWS the region is a setting, first ap-southeast-2 |
| 7 | A schema per client in one Postgres database |
| 9 | Files, mail, models, vectors: S3, SES, Bedrock in the deployment's region, pgvector |
| 13 | The whole host is wanted on AWS, in stages, video included |

## The design in one page

| Today on Cloudflare | On AWS | Seam |
| --- | --- | --- |
| Workers AI through AI Gateway | Bedrock, called in the deployment's region with the task's role | a provider in `roles.ts` and `client.ts` |
| Vectorize index `cos-records` | a pgvector table in each client's schema | `VectorStore` |
| Email Service binding | SES | `EmailTransport` |
| Stream | off, or Stream by the operator's choice (question 1) | `VideoHost` |

Nothing above the seams changes. A role is still the only thing code names.

## The model

### Models

- **A `bedrock` provider** joins `PROVIDERS`: no key, since the host's task role is allowed to
  invoke models (stage 70's module grants it for the region only). Its models are added to the
  catalogue with their capabilities, so the existing checks apply.
- **A default per role per target.** `SHIPPED_ROLES` becomes one set for Cloudflare (unchanged)
  and one for AWS. The host picks the set from the target it runs on. The other two layers work
  as today.
- **Which Bedrock models are the defaults is step 1's work,** not this spec's. Step 1 lists what
  can be invoked in ap-southeast-2, tests each candidate against each role's needs and the
  existing evals, and records the choice. A role with no suitable model in the region has no
  default, and the feature that needs it says it is not set up.
- **Staying in the region.** Some Bedrock models can be called only through an inference profile
  that spreads calls over several regions. A profile is allowed only when every region it uses
  is inside the area the deployment declares; for the first use that is Australia. Step 1
  records which candidates this rules out.
- **No gateway.** Usage is counted by the host as hosted deployments already do (`usage.ts`).
  Bedrock's own invocation logging stays off, so no prompt is kept anywhere an erase cannot
  reach. Spend comes from the catalogue's prices.
- **Other providers.** A deployment's allowed providers are a registry setting (stage 66's "AI
  roles and providers"), written only by the operator. On AWS it defaults to `bedrock` alone. A
  provider outside AWS is allowed only by the operator, appears in the residency statement, and
  takes its key from `cos secret set` (stage 70). Settings, AI on AWS shows roles and usage and
  does not take keys.
- **Speech** (`transcribe`, `speak`) has no AWS default here. Voice belongs to the assistant
  (stage 72).

### Search by meaning

- **`pgvectorStore`** implements `VectorStore` over the client's database handle: a core table in
  the Postgres migration set holding the vector id, the object, the record id and the embedding,
  with a cosine index. `query` filters by object in SQL and returns a similarity as Vectorize
  does (higher is nearer), at most 50. `VectorizeLike` stays the Vectorize binding's shape; AWS
  does not imitate it.
- **Per client by construction:** the table is in the client's schema, so stage 66's namespace
  per client is not needed, and erase, export and backup already cover it.
- **The dimension** is fixed for the Postgres target by the embed default chosen in step 1 and
  written in the migration. The existing check refuses an embed model of another size.
- **When the model differs between targets,** vectors are not carried. Embeddings are derived
  data: an export leaves them out, and an import queues every record. Because the model's id is
  in the text hash, the backfill re-embeds everything once without new code. Until it finishes,
  search uses text only, as it does today without a vector store.
- **To confirm in step 1:** the pgvector version RDS offers, and whether a filtered query on its
  approximate index returns a full page, or small clients are better served by an exact scan.

### Mail

- **`sesTransport`** implements `EmailTransport` with SES in the deployment's region: from, to,
  cc, bcc, reply-to, text, HTML, the unsubscribe headers and the two kinds of attachment the
  gatekeeper makes. If SES's structured send cannot carry an attachment or a header, the
  transport builds the MIME message itself (step 1 confirms).
- **Errors** are mapped onto the same question the gatekeeper asks today: refused before sending
  (an unverified sender, a suppressed recipient, a paused or sandboxed account, a limit) or
  unknown. One contract test runs against both transports.
- **Sender identity is a deploy step.** Stage 70's module takes `mail_domain`, creates the SES
  identity with DKIM and a MAIL FROM domain, and outputs the DNS records. `cos deploy` checks the
  identity is verified and the account is out of SES's sandbox, and says what a person must do
  when it is not: add the records, and ask AWS for production sending (a request per account and
  region that only a person can make).
- **Allowed senders** move from the binding's settings to the task role's policy: the host can
  send only from the addresses `product.ts` lists, whatever its code does.
- **SES's suppression list** is on. It holds addresses at rest, in the region, and is in the
  residency statement.
- **The gatekeeper itself.** `email-send` is a Worker with a Durable Object. How a gatekeeper
  runs on AWS is stage 73's design. This stage builds the transport and the deploy step; stage
  73 puts the gatekeeper on it and proves a sign-in code arrives. Mail in is stage 73's too.

### Video

`VideoHost` talks to Stream over HTTPS, so an AWS host can use Stream unchanged. Whether Stream
can keep video at rest in Australia has not been checked. The options:

| Option | Work | Residency |
| --- | --- | --- |
| A. Off on AWS | none: video operations answer "not configured", as today without Stream | nothing leaves |
| B. Stream, by the operator's choice | none in code; a registry setting and a line in the statement | video is held by Cloudflare, where it chooses, unless Cloudflare commits otherwise in writing |
| C. An AWS path: uploads to S3, renditions by a transcoding service, signed playback, captions, our own player | a stage of its own; `VideoHost` exposes Stream's player and upload protocol, so blocks change too | in the region, if playback uses no worldwide cache |

See question 1.

### Small Cloudflare services

| Service | Where | On AWS |
| --- | --- | --- |
| Turnstile | `intake/runtime.ts`, the form page | Kept. It works from any host, and holds no record. It sees a visitor's address and browser; the statement names it. Without its key public forms stay closed |
| AI Gateway | `client.ts`, `admin.ts` | None. Usage by the host; logging off at Bedrock |
| Provider keys from Settings | `admin.ts` | The operator's `cos secret set` |
| Cloudflare Images | `apps/app/src/server/media.ts`, optional | None. The original is served, as today without the binding |
| Cloudflare Access sign-in | `packages/auth/src/cloudflare-access.ts` | Not offered. Preflight refuses it on AWS |
| The edge rate-limit rule `cos` prints | `client-repo.ts` (`edgeRuleStep`) | The WAF rule in stage 70's module |
| `cf-connecting-ip`, the Cache API, rate-limit bindings | the app's HTTP entries, `dashboards/cache.ts`, `rate-limit.ts` | Stage 68 |
| Workers AI over REST, Platform AI | `workers-ai-rest.ts`, `platform.ts` | Not used |

## Out of scope

- The assistant, voice and the speech roles (stage 72).
- The gatekeeper runtime on AWS, mail in, and every other connection (stage 73).
- An AWS video path (option C), unless question 1 asks for it.
- Bounce and complaint events reaching the host; resizing images on AWS; a CAPTCHA of AWS's own
  in place of Turnstile.
- Changing any default, index or transport on Cloudflare.

## Acceptance criteria

1. A written record lists, for each role, the Bedrock model chosen for ap-southeast-2, how it was
   invoked, and the evals it passed; a role with none says so.
2. On an AWS deployment every text role resolves to `bedrock` with no deploy config, and
   `packages/core`'s AI tests pass with the AWS defaults against fakes.
3. A call for a role reaches Bedrock in the deployment's region and no other; a test fails when
   a configured model would use a region outside the declared area.
4. A deployment set to `bedrock` only refuses a role configured for another provider.
5. Usage per role and day is shown in Settings, AI on AWS with no gateway.
6. `pgvectorStore` passes the same contract tests as `memoryVectorStore`; two clients' vectors
   are in separate schemas and a query for one never returns the other's.
7. A client imported with no vectors is searchable by text at once and by meaning after the
   backfill, with no command run.
8. Erasing a record removes its vector in the same unit of work as its bookkeeping row.
9. `sesTransport` passes the transport contract; each SES refusal maps to "refused before
   sending" or "unknown" as the table in its tests says.
10. `cos deploy` reports an unverified mail domain or a sandboxed SES account, and a send from an
    address not in `product.ts` is refused by AWS, not only by the host.
11. Nothing on a Cloudflare deployment changes: its defaults, index and tests are as before.
12. The residency statement (stage 70) names every service outside AWS that is on.

## Dependencies

Stage 68. Stage 70's module for the Bedrock permission, the SES identity and the sender policy.
Stage 73 builds on this stage's transport, not the other way round. Model access in the AWS account, which a person may have to
request per model.

## Migrations and numbers

One Postgres migration for the vector table, in stage 67's set. No SQLite migration. The first
build step claims a block for its ADRs in [`docs/parallel-work.md`](../parallel-work.md).

## Suggested build order

1. **Spike: what the region offers.** Models invocable in ap-southeast-2 for each role and how;
   the embed model and its size; the pgvector version and filtered-query behaviour; whether SES's
   structured send carries attachments and headers. Written up, with a default proposed per role.
2. **The Bedrock provider,** the AWS default set and the provider allow-list. Usage with no
   gateway. Criteria 2 to 5.
3. **`pgvectorStore`** and its migration, with the contract tests. Criteria 6 to 8.
4. **`sesTransport`,** the error map and the contract test. Criterion 9.
5. **Mail as a deploy step:** the module's SES parts, the checks in `cos deploy`, the sender
   policy. Criterion 10.
6. **The small services and the docs:** Access refused on AWS, the statement's list, the video
   choice from question 1, `docs/deploying.md` and the AI guide.

Steps 2 to 5 can run side by side after step 1.

## Decided by this spec, open to override

- **Defaults per target, chosen by evidence in step 1,** not named here.
- **Bedrock only, unless the operator allows more.**
- **No AI gateway on AWS.**
- **pgvector behind `VectorStore`,** in the client's schema, not behind `VectorizeLike`.
- **Vectors are never moved between targets;** they are rebuilt.
- **Provider keys on AWS are the operator's,** not set from Settings.
- **Turnstile stays.**
- **Cloudflare Access is not a sign-in choice on AWS.**

## Questions for the owner

1. **Video on AWS.** Recommended: option A as the default and option B as a setting the operator
   may turn on, with the AWS path (C) built as its own stage only if the first product needs
   video that must stay in Australia. A costs nothing, B is honest about where the video is, and
   C is weeks of work that should follow a known need. We also ask Cloudflare in writing where
   Stream keeps video.
2. **May a deployment that promises Australian residency use a model that runs in Australia but
   outside Sydney** (an inference profile over Sydney and Melbourne)? Recommended: yes, since the
   promise is the country, and it may be the only way to reach the stronger models. If no, some
   roles may have weaker defaults or none.
3. **If no model in the region is good enough for the assistant's main role, what gives?**
   Recommended: ship without that role on AWS and say so, not send prompts abroad by default. An
   operator who accepts it can allow another provider.

## Status

Spec proposed (2026-11-26). No build step is built yet.

- **Step 1** — not built — needs: an AWS account with model access — Spike: what the region offers for models, vectors and mail

- **Step 2** — not built — needs: step 1, stage 68 — The Bedrock provider, AWS defaults, the provider allow-list, usage

- **Step 3** — not built — needs: step 1, stage 68 — `pgvectorStore` and its migration

- **Step 4** — not built — needs: step 1 — `sesTransport`, the error map and the contract test

- **Step 5** — not built — needs: step 4, stage 70 — Mail as a deploy step: SES identity, checks, sender policy

- **Step 6** — not built — needs: step 2, step 3, step 5 — The small services and the docs
