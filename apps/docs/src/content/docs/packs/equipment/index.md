---
title: "Equipment"
description: "A register of what a business owns and looks after, with tags, suppliers, costs and warranties; faults reported by staff; items taken out of service by any staff member and put back by a manager."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

A register of what a business owns and looks after, with tags, suppliers, costs and warranties; faults reported by staff; items taken out of service by any staff member and put back by a manager.


## What it is for

Equipment keeps a register of the things a business owns and must look after: a gym's treadmills,
racks, cable machines and sauna; a tradesperson's tools, test gear and vans. Each item has its
details, where it is, who supplied it, what it cost and when its warranty ends. Staff report faults
from the floor, and anyone who sees something unsafe takes the machine out of service in the same
step. Only a manager puts it back.

It requires no other pack.

## Concepts

- **Item** (`equipment.item`): one thing the business looks after, with a name, category (editable;
  seeded Cardio, Strength, Free weights, Studio, Wet area, Tool, Test gear, Vehicle, Other), place,
  **tag** (the code on its sticker), make, model, serial, bought on, cost, supplier (an
  Organisation), warranty until and its notes, photo, **keeper** (the staff account who looks after
  it; empty means the managers), who has it now, a renewal date (a van's registration), whether it
  is listed for members (not listed by default) and notes.
- **States of an item**: in service, **out of service** (why, and since when) or retired (final).
- **Fault** (`equipment.fault`): a report that something is wrong with an item: what is wrong, how
  bad (safety risk, not working, worn or cosmetic), an optional photo, and who reported it. Its
  title reads "<item> fault" unless one is given.
- **States of a fault**: reported, acknowledged, then fixed, not a fault or a duplicate (final),
  each close with why.

## How the pieces fit

- **The tag is the host's.** No two live items share a tag ([unique](/reference/behaviours/#unique)):
  the database refuses the second, from a form, the assistant, MCP or an import. An item without a
  tag is not compared. Importing a register from a spreadsheet uses the admin's import; run again
  with "skip invalid rows", the rows whose tag already exists are skipped, so nothing is made twice.
- **Every move is a tool's.** No record write, board drag or import moves an item or a fault
  ([states](/reference/behaviours/#states)); only the pack's tools do, and the host makes sure of it.
  Taking an item out of service needs why; the time it went out is set with it. Putting it back
  clears both. Retiring needs why, kept in the notes, and unlists the item for members.
- **Who may do what.** Every staff member holds `equipment:report`: the register, one item,
  reporting a fault and taking an item out of service. An admin grants it to a coach or a cleaner
  on a pack role, who then reaches those and nothing else of the pack. `equipment:manage` is
  restricted: admins, and whoever an admin grants it to, put items back in service, retire them
  and triage faults.
- **What an AI may do.** The assistant and MCP clients read the register and items. A fault report,
  a take-out, retiring and triage they ask for wait for a person to approve, whatever the approval
  preset. Putting an item back in service is a person's own act: it is refused to them.
- **Costs** (what an item cost to buy) are read by every staff member.

## Main flows

1. **Build the register.** A manager adds items, or imports them from a spreadsheet, each with its
   tag, supplier, cost and warranty date.
2. **Report a fault.** A staff member calls `reportFault` with the item, what is wrong and how bad.
   Seeing something unsafe, they add `takeOut` with why, and the item is out of service in the same
   call. The answer says whether the item is under warranty.
3. **Take an item out.** `takeOut`, or the item page's "Take out of service" button, with why.
4. **Triage.** A manager acknowledges the fault with `triage`, then closes it as fixed, not a fault
   or a duplicate, with why.
5. **Put it back.** Once it is safe, a manager calls `putBack`, or presses "Put back in service".
6. **Retire it.** A manager calls `retire` with why (worn out, replaced, sold, lost).
7. **Read the register.** `register` lists items with their state, keeper, supplier, warranty and
   open faults, out-of-service items and safety risks first; `item` shows one item with its faults
   newest first.

## What is built

Items and faults, the tag's uniqueness, the states and their tools, the two permissions, the
item's Faults tab, and the tools `register`, `item`, `reportFault`, `takeOut`, `putBack`, `retire`
and `triage`.

Not in the code yet: service plans, maintenance, inspections and their checklists; the item's
keeper triaging its faults; members' fault reports, the out-of-order list and My reports;
notices, the Task per maintenance, the dashboard and views; the blocks and screens.


## Reference

Generated from the code:

- [Data model](/packs/equipment/data-model/)
- [Operations and tools](/packs/equipment/tools/)
- [Permissions and roles](/packs/equipment/permissions/)
- [Screens](/packs/equipment/screens/)
- [Messages](/packs/equipment/messages/)
- [Settings](/packs/equipment/settings/)
- [Decisions](/packs/equipment/decisions/)

The specification is stage 59's, [59-equipment.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/59-equipment.md).

This page is [equipment/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/equipment/docs/overview.md), written by hand beside the code.
