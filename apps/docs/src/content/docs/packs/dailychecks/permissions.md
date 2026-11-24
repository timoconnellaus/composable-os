---
title: "Daily checklists: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

None.

## Roles

This pack declares no roles.

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [today](/packs/dailychecks/tools/#today) | yes |   | yes |   |
| [day](/packs/dailychecks/tools/#day) | yes |   | yes |   |
| [tick](/packs/dailychecks/tools/#tick) | yes |   | yes |   |
| [done](/packs/dailychecks/tools/#done) | yes |   | yes |   |
| [history](/packs/dailychecks/tools/#history) | yes |   |   | `checklists:write` |
