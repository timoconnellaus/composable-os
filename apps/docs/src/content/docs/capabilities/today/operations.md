---
title: "Today: operations"
sidebar:
  label: "Operations"
  order: 1
editUrl: false
---

The core operations that are this capability's (named `today.`). Each links to its full reference, with its input and output.

| Operation | What it does | Audiences | Risk | Permission |
| --- | --- | --- | --- | --- |
| [`today.get`](/reference/operations/today/#todayget) | Today at a glance, for the business's current local day in its own time zone: the items you may see, attention first, each with its key, label, value (a count, a percent, or money in the currency's minor unit), a comparison with the same time yesterday or last week, whether it needs attention, and what it opens. Items include takings (for those who may read the finance reports), the changes waiting for your approval, shifts with nobody on them and checklists missed (for those who roster), unread notices, and the numbers installed packs add (such as classes today and who came). An assistant or MCP client gets only the packs' items and the money its user may see. today.rows gives an item's rows. Read-only. | `staff` | `read` | `records:read` |
| [`today.rows`](/reference/operations/today/#todayrows) | The rows behind one item of today.get (its key), at most 50: for each a name, a second line and the record it opens, if any. Only an item today.get gives you: any other key is not found. Names and record ids only, never notes, health answers, pay or leave. A look at a money item's rows is audited. Read-only. | `staff` | `read` | `records:read` |
