# ADR 0001: Self-hosted, one org per deployment

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
The CRM is meant to be owned by the organisations that use it, running in their own Cloudflare account.
We will run our own instance, deployed exactly like anyone else's. There is no hosted multi-tenant offering.

## Decision
- One deployment serves one org. The deployment is the isolation boundary, so there is no tenant id in the data model.
- Deployments require the Workers Paid plan (dynamic workers, Workflows, Queues, CPU limits).
- The repo must stay deployable by strangers: self-contained `wrangler.jsonc` files, documented secrets, no reliance on our accounts.

## Consequences
- Simpler data layer and auth. Adding multi-tenancy later would be a significant change, accepted knowingly.
- Every external dependency (AI keys, OAuth apps) is supplied per deployment.

## Amended 2026-11-23: a deployment may hold many clients
[ADR 0611](0611-one-host-a-database-per-client.md): a hosted deployment serves many clients, each
with a database of its own, chosen by the host on every request. What this record protects is
kept: one organisation's data is one database, the isolation boundary is that database, and no
table has a tenant id. A self-hosted install, and a client in its own Cloudflare account, is still
one deployment for one organisation, as described here.

## Amended 2026-11-24: locations inside the one organisation
Stage 64 ([ADR 0910](0910-locations-a-base-record-inside-the-one-organisation.md)) adds
**locations**: the places one organisation works from (a gym's second studio), as a base record
inside it. A location is never a tenant: nothing is keyed by it, and the deployment stays the
isolation boundary. Separately owned businesses that share a brand are still separate deployments.

> Note, 2026-11-26 ([ADR 0950](0950-two-targets-cloudflare-and-aws.md)): a deployment may also run on
> AWS, a second target. What this record says about Cloudflare stands for the Cloudflare target.
