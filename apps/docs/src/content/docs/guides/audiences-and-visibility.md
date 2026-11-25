---
title: "Audiences and the visibility seam"
description: "Who may call an operation (staff, customers, the public) and how the host limits what each one sees."
sidebar:
  order: 2
editUrl: false
---

An outline; the full description is in [docs/architecture.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#audiences-and-customers).

## Three audiences

Every operation declares its audiences ([ADR 0402](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0402-staff-and-customers.md),
[ADR 0411](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0411-audiences-on-operations-as-built.md)):

- **staff**, the default: the business's users, with roles and permissions;
- **customer**: a Person with a sign-in, limited to their own records;
- **public**: callers with no account. Public operations are few, low risk and rate limited.

Opening an operation or a pack's tool to `customer` or `public` is a reviewed change: its risk
class must be `read` or `write`, and it joins `packages/core/open-operations.json`, which a test
keeps equal to the registry. A caller outside an operation's audiences gets the answer an unknown
operation gets. Each operation's audiences are on its [reference entry](/reference/operations/).

## The visibility seam

Every read of a record takes its source from one place, `packages/core/src/visibility/`
([ADR 0410](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0410-the-seams-first-door-as-built.md)). Staff get the plain view. A customer
gets only their own rows and only the columns the object lists. The public get only what an
object declares public. Objects say so with declarations such as `customer`, `public`,
`customerVia` and `access`, listed with the [behaviours](/reference/behaviours/).

## A customer's call

A call for a customer or the public carries a principal and no staff user. It takes its own short
path in the pipeline: no role, no approval queue, a write check at the seam before the batch
commits, and an audit row naming the actor. Its handler has no raw database: it reads and writes
records through the seam ([ADR 0413](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0413-outside-handlers-have-no-raw-database.md)). A
pack's tool called by a customer runs as that customer
([ADR 0414](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0414-pack-tools-run-as-the-customer.md)).

## Rules live in the host

Prices, places and what a customer may see are enforced by behaviours and the seam, never by a
block or a client app ([ADR 0404](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0404-behaviours-are-the-vocabulary.md)). A client app
shows what the host answers and decides nothing.


This guide is [docs/guides/audiences-and-visibility.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/audiences-and-visibility.md), written by hand beside the code.
