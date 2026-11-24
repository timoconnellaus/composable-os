---
title: "rostering-pay"
description: "Pay (stage 45 step 7), for someone who handles pay, a person only: the pay periods, who is counted and how, a period's hours and shifts per person and kind of work with each shift's evidence (its class list taken, by whom, flagged when not by its person), locking a period that has ended, reopening one with why, and its CSV for payroll."
editUrl: false
---

Pay (stage 45 step 7), for someone who handles pay, a person only: the pay periods, who is counted and how, a period's hours and shifts per person and kind of work with each shift's evidence (its class list taken, by whom, flagged when not by its person), locking a period that has ended, reopening one with why, and its CSV for payroll. No rates and no money: the host holds none. Everything is the host's answer: which periods exist, what each counts (a locked period's locked lines, an open one's preview), whether it may be locked, and each refusal (the period not set, not ended, already locked or overlapping one, the roster changed while locking, a shift inside a locked period). Shown only when the host says the reader handles pay (`me.pays`), so no one else's screen asks for any of it. Figures are kept in the app's cache no longer than they are shown, hidden when the page is left, and the CSV is handed to the person and not kept; why a period was reopened is forgotten once the call is over.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-pay` |
| Files | `pay.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.periods`](/packs/rostering/tools/#periods)
- [`x.rostering.periodTotals`](/packs/rostering/tools/#periodtotals)
- [`x.rostering.lock`](/packs/rostering/tools/#lock)
- [`x.rostering.reopen`](/packs/rostering/tools/#reopen)
- [`x.rostering.export`](/packs/rostering/tools/#export)
- [`x.rostering.payBases`](/packs/rostering/tools/#paybases)
- [`x.rostering.payBasis`](/packs/rostering/tools/#paybasis)

Source: [packs/rostering/blocks/rostering-pay](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-pay).
