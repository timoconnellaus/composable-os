# Architecture decision records

One file per decision, numbered in the order the blocks were claimed
([`../parallel-work.md`](../parallel-work.md)). A decision that changes is amended with a dated
note in its own file; it is not rewritten or deleted.

## The records before 0400 keep the names of their time

ADRs 0001 to 0352, and stage specs 00 to 17 in [`../stages/`](../stages/), were written before the
repository became Composable OS (ADR [0400](0400-a-general-host-and-products.md), stage 20). They are
records of what was decided then and are left as written: they say Relationship OS, `@crm/*` or
`@relationship-os/*`, `ros-app`, `ROS_*`, `codemode:crm`, `ctx.crm` and the `crm_*` views. Read
those names as what they became:

| Then | Now |
| --- | --- |
| Relationship OS (the product) | The CRM, a product on Composable OS |
| `@relationship-os/*`, `create-relationship-os`, the `ros` command | `@composable-os/*`, `create-composable-os`, `cos` |
| `ros-app`, `ros-runner`, `ros-gatekeeper-*`, the database `ros` | `cos-*` in packages and local development; named for the product in a deployment (`crm-app`, `crm-runner`, the database `crm`) |
| `ROS_*` variables | `COS_*` |
| `codemode:crm`, `ctx.crm` | `codemode:ops`, `ctx.ops` |
| `crm_people`, `crm_organisations`, `crm_x_deals_deal`, … | `rec_person`, `rec_organisation`, `rec_x_deals_deal`, … (migration 0380) |
| `apps/control` | `products/crm/apps/control` |

What those records say about upgrading installs made under an older name (ADR 0193, and parts of
0160 to 0169) no longer applies: nothing was installed, and that code was deleted in stage 20.

ADRs from 0400 on use the current names. The name lint (`scripts/check-stray-names.mjs`) allows the
old names only in the historical records, in ADR 0400 and the stage 20 spec, which have to say what
was retired, and in this file.
