---
title: "Equipment: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `equipment:report` | [register](/packs/equipment/tools/#register), [item](/packs/equipment/tools/#item), [reportFault](/packs/equipment/tools/#reportfault), [reportFaultOnly](/packs/equipment/tools/#reportfaultonly), [takeOut](/packs/equipment/tools/#takeout) |   | yes |   | Equipment: see the register, report a fault and take an item out of service. For a coach, a cleaner or anyone with another role who works on the floor. |
| `equipment:manage` | [putBack](/packs/equipment/tools/#putback), [retire](/packs/equipment/tools/#retire), [triage](/packs/equipment/tools/#triage), [correctFault](/packs/equipment/tools/#correctfault), [correctOutReason](/packs/equipment/tools/#correctoutreason) | yes | yes |   | Equipment: put items back in service, retire them, acknowledge and close faults, and correct a fault's report or why an item is out of service |

## Roles

This pack declares no roles.

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [reportFault](/packs/equipment/tools/#reportfault) |   | yes |   |   |
| [takeOut](/packs/equipment/tools/#takeout) |   | yes |   |   |
| [putBack](/packs/equipment/tools/#putback) | yes |   |   |   |
| [retire](/packs/equipment/tools/#retire) |   | yes |   |   |
| [triage](/packs/equipment/tools/#triage) |   | yes |   |   |
| [correctFault](/packs/equipment/tools/#correctfault) |   | yes |   |   |
| [correctOutReason](/packs/equipment/tools/#correctoutreason) |   | yes |   |   |
