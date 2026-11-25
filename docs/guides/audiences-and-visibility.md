---
title: Audiences and the visibility seam
description: Who may call an operation (staff, customers, the public, practitioners) and how the host limits what each one sees.
order: 2
---

An outline; the full description is in [docs/architecture.md](../architecture.md#audiences-and-customers).

## The audiences

Every operation declares its audiences ([ADR 0402](../adr/0402-staff-and-customers.md),
[ADR 0411](../adr/0411-audiences-on-operations-as-built.md)):

- **staff**, the default: the business's users, with roles and permissions;
- **customer**: a Person with a sign-in, limited to their own records;
- **public**: callers with no account. Public operations are few, low risk and rate limited:
  per client address for floods (600 reads, 120 writes a minute), and per caller on order starts,
  checkout, code checks and form answers ([ADR 0940](../adr/0940-a-rate-limit-per-client-address-for-public-operations.md));
- **practitioner**: an outside person the business invited (a physiotherapist, a dietitian),
  signed in to their own practitioner account
  ([ADR 0581](../adr/0581-the-practitioner-principal-accounts-and-sign-in.md)). One operation is
  open to them, `practitioner.me`, and the seam gives them no record of any object yet;
- **device**: the business's own enrolled tablet, on the desk origin only.

Opening an operation or a pack's tool to `customer`, `public` or `practitioner` is a reviewed change: its risk
class must be `read` or `write`, and it joins `packages/core/open-operations.json`, which a test
keeps equal to the registry. A caller outside an operation's audiences gets the answer an unknown
operation gets. Each operation's audiences are on its [reference entry](/reference/operations/).

## The visibility seam

Every read of a record takes its source from one place, `packages/core/src/visibility/`
([ADR 0410](../adr/0410-the-seams-first-door-as-built.md)). Staff get the plain view. A customer
gets only their own rows and only the columns the object lists. The public get only what an
object declares public. Objects say so with declarations such as `customer`, `public`,
`customerVia` and `access`, listed with the [behaviours](/reference/behaviours/).

## A customer's call

A call for a customer or the public carries a principal and no staff user. It takes its own short
path in the pipeline: no role, no approval queue, a write check at the seam before the batch
commits, and an audit row naming the actor. Its handler has no raw database: it reads and writes
records through the seam ([ADR 0413](../adr/0413-outside-handlers-have-no-raw-database.md)). A
pack's tool called by a customer runs as that customer
([ADR 0414](../adr/0414-pack-tools-run-as-the-customer.md)).

## Practitioner accounts and sign-in

A person on the staff with `practitioners:manage`, at the web admin, invites a practitioner
(`practitioner.invite`) and ends their account (`practitioner.end`, which ends every session at
once); the assistant, MCP, automations, extensions and a device session cannot. The practitioner
signs in by an emailed code at `/api/practitioner-auth/*`, on the host or over the client-app
binding, where the business's web app forwards their `cos-practitioner.*` cookie and calls
through the generated `practitioner.ts` client. One address may hold a staff, a customer and a practitioner account:
each is signed in on its own, and a request carrying two kinds of session is refused.

## Rules live in the host

Prices, places and what a customer may see are enforced by behaviours and the seam, never by a
block or a client app ([ADR 0404](../adr/0404-behaviours-are-the-vocabulary.md)). A client app
shows what the host answers and decides nothing.
