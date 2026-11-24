# ADR 0610: Three homes for a client, hosted in our account by default

Status: accepted, 2026-11-23 (interview "Where client products run", the owner's answers of the
same day). Amends [ADR 0191](0191-saas-and-enterprise-model.md),
[ADR 0210](0210-hosted-deployments-on-workers-for-platforms.md) and
[ADR 0422](0422-client-repos-and-one-command-as-built.md). Keeps
[ADR 0001](0001-self-hosted-single-org.md) and [ADR 0400](0400-a-general-host-and-products.md).
Built by [stage 46](../stages/46-hosted-clients.md); nothing here is built yet.

## Context
A client product is deployed by `cos deploy` from its own repository into whichever Cloudflare
account the token belongs to (ADRs 0422, 0450). The first client, a gym, runs in its own account.
The site sells a product built for the business and maintained on one subscription (ADR 0465),
which is easier to keep when the client needs no Cloudflare account and every client can be
updated from one place.

Stage 10 built hosting in our account on Workers for Platforms (ADR 0210): the deploy engine
targets a dispatch namespace, a dispatch Worker routes verified hostnames and runs crons, and a
rollout updates every deployment. It was built for the CRM sold by self-serve sign-up, tested
against fakes, and never deployed. Its control plane knows nothing about a client product: no
packs, no org extensions, no web app, no label.

## Decision
- **A client product has one of three homes.**

  | Tier | What the client has | Where it runs |
  | --- | --- | --- |
  | Standard | Settings only (name, brand, domain). No repository. | Its own host and database in our namespace, on a standard product's release. One web app shared by every client of that product. |
  | Bespoke | Its own repository, web app and extensions. | Its own host and database in our namespace. |
  | Own account | The same as bespoke. | The client's Cloudflare account. The exception. |

- **The default is our Cloudflare account,** in a Workers for Platforms dispatch namespace.
- **Clients are kept apart by their data, never by a tenant id.** Every client, on every tier, has
  its own Workers, database, bucket, queues and Durable Objects. ADR 0001 stands: nothing in a
  deployment's data says whose it is. What is shared is code with no client data in it: the
  dispatch Worker, the Platform AI gateway (ADR 0213) and a standard product's web app. One Worker
  and one database serving several clients was considered and refused: it rewrites every table,
  query and extension to filter by tenant, one missed filter shows one client another's customers,
  and it makes moving a client out a cut through a shared database.
- **Moving between tiers changes where code runs, not the client's records.** Standard to bespoke:
  the host and database stay as they are, and the client gains a repository that adopts the host.
  To the client's own account: an install there and a copy of its data.
- **A client may leave for its own Cloudflare account at any time, with its data.** We say so.
- **A client goes in its own account when** it or its contract asks, when compliance or data
  ownership rules require it, or when it wants more control, for example to write and deploy code
  itself.
- **`cos deploy` gains a hosted target,** driven from the client repository. The stage 10 control
  plane (sign-up, plans, trials, Stripe) is not used for client products. Its generic parts
  (dispatch, the rollout, export) are reused.
- **We set the platform version of the hosted fleet.** One command updates every hosted host,
  environments that are not live first. A hold can be put on one client. In a hosted client's
  repository `cos deploy` deploys only what is the client's own: its web app, its extensions, its
  choice of packs and its settings.
- **Cloudflare usage is included in the subscription up to a fair-use limit,** measured per client.
- **The first client moves in.** The gym's staging and live hosts move from its own account into
  ours together, as the first hosted client. It stays bespoke.
- **The first standard product is built from that client's setup,** with what only that client
  needs left in its own extensions. It has its own interview and stage.
- **No trial on a real namespace came before this decision.** What ADR 0210 lists as never
  verified for Workers in a namespace is verified in stage 46's first build step, each with the
  fallback named there.

## Consequences
- **One account holds every hosted client.** A suspension, a billing failure or a leaked account
  token reaches all of them. Account-level products that a token cannot scope to one client (Stream
  above all) must be reached through a broker that scopes them, not by giving each host the token.
- **The leaving promise needs a real move:** the database, files, key-value data, Durable Object
  storage, secrets and videos of one host carried to another account. Nothing of the kind exists
  (ADR 0214's export is a database dump link and a read token). Stage 46 builds it, and the first
  client's move in is its first use.
- **A hosted bespoke client cannot deploy by itself:** an account token cannot be limited to one
  client's Workers. Its deploys run with our token. Wanting to deploy alone is a reason for the
  own-account tier.
- **`product.ts` no longer decides a hosted host's platform version.** It says which version the
  repository was generated against; the fleet's version is what runs.
- **ADR 0191's enterprise forms** map onto this: "dedicated" is the bespoke tier, "managed in their
  own account" is the own-account tier. Whether the hosted CRM is sold by sign-up is still not
  decided (ADR 0465).
- Per-client measurement exists for AI only. Stream, stored files, database size and Worker usage
  need adding before a fair-use limit means anything.

## Amended 2026-11-23: the first client, the repository, the account
From the owner's answers to stage 46's open questions, the same day:
- **The first client does not move in.** It has nothing in its own account's staging or live hosts
  yet, so its first deploys go to our account as fresh installs. The move between accounts is
  still built, for the leaving promise, before a second client is hosted.
- **A hosted bespoke client's repository is ours while it is hosted** and is transferred to the
  client, with its history, when it moves to its own account. The deploy secret can reach every
  hosted client, so only we may push to a repository that holds it.
- **The fleet's account is the one `composableos.dev` is on.** A separate account used only for
  hosted clients was offered and not chosen, so the first consequence above also covers whatever
  else runs in that account.
- Hosted hostnames are on `composableos.app`. A moved host's source is kept for 90 days. Fair-use
  limits are set after two months of reported usage.


## Amended 2026-11-24: a client with several locations is one host
A client with two or three locations it owns runs them from one host, sharing one member list
(stage 64, decision 1; [ADR 0910](0910-locations-a-base-record-inside-the-one-organisation.md)):
the locations are records inside it, and clients are still kept apart by their data, never by a
tenant id. Only a franchise (each location a different owner) is several hosts, one per owner.
