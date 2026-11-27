---
title: "Memberships: decisions"
sidebar:
  label: "Decisions"
  order: 90
editUrl: false
---

The decisions this pack rests on, as recorded in the repository's ADRs.

| ADR | Decision |
| --- | --- |
| [ADR 0485](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0485-recurring-billing-the-provider-runs-the-schedule.md) | Recurring billing: the provider runs the schedule, the host mirrors current reads |
| [ADR 0487](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0487-the-payer-and-the-holder.md) | A subscription's payer and its holder are two People |
| [ADR 0489](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0489-one-free-trial-per-person-per-plan.md) | One free trial per Person per plan object, for a proved holder, used when the provider confirms it |
| [ADR 0493](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0493-the-allowance-behaviour.md) | The allowance behaviour: holders, spenders, and a limit the database keeps |
| [ADR 0494](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0494-which-holder-pays-and-what-happens-to-uses.md) | Which holder pays, and what happens to uses when a holder or its Person changes |
| [ADR 0510](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0510-what-a-subscription-grants.md) | What a subscription grants, kept in step with it (`sellable.recurring.grants`) |
| [ADR 0511](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0511-the-memberships-pack-and-passes.md) | The Memberships pack: plans, memberships, pass types and passes |
| [ADR 0512](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0512-one-per-person-and-tools-only-a-person-may-call.md) | Bought once per Person (the intro offer), and tools only a person may call |
| [ADR 0513](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0513-a-granted-holder-keeps-what-it-was-granted.md) | A granted holder keeps what it was granted: the Trash, moves only a person's tool makes, and its terms |
| [ADR 0530](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0530-plan-changes-upgrade-now-downgrade-next-period.md) | Plan changes: an upgrade now, applied once paid; a downgrade from the next period |
| [ADR 0531](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0531-staff-pause-a-membership-for-a-set-time.md) | Staff pause a membership for a set time: the provider's pause, followed by the host |
| [ADR 0532](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0532-the-memberships-dashboard-and-staff-side.md) | The Memberships dashboard, views, the Person page and the members' blocks |
| [ADR 0647](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0647-cooling-off-a-new-member-ends-it-for-a-full-refund-a-person-approves.md) | Cooling off: a new member ends it for a full refund, a person approves each refund |
| [ADR 0764](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0764-appointments-in-the-bookings-pack.md) | Appointments in the Bookings pack, booked by staff |
| [ADR 0980](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0980-general-and-domain-packs.md) | General and domain packs, and the class type in Bookings |

The specification is stage 32's, [32-memberships.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/32-memberships.md).
