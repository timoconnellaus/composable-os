---
title: "Offers: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `offers:manage` | [draftDiscount](/packs/offers/tools/#draftdiscount), [changeDiscount](/packs/offers/tools/#changediscount), [activateDiscount](/packs/offers/tools/#activatediscount), [pauseDiscount](/packs/offers/tools/#pausediscount), [endDiscount](/packs/offers/tools/#enddiscount), [generateCodes](/packs/offers/tools/#generatecodes), [voidBatch](/packs/offers/tools/#voidbatch), [voidCodes](/packs/offers/tools/#voidcodes) |   |   |   |   |

## Roles

This pack declares no roles.

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [changeDiscount](/packs/offers/tools/#changediscount) |   | yes |   |   |
| [activateDiscount](/packs/offers/tools/#activatediscount) |   | yes |   |   |
| [pauseDiscount](/packs/offers/tools/#pausediscount) |   | yes |   |   |
| [endDiscount](/packs/offers/tools/#enddiscount) |   | yes |   |   |
| [generateCodes](/packs/offers/tools/#generatecodes) | yes |   |   |   |
| [voidBatch](/packs/offers/tools/#voidbatch) |   | yes |   |   |
| [voidCodes](/packs/offers/tools/#voidcodes) | yes |   |   |   |
