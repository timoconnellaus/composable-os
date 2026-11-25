---
title: "Knowledge: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `knowledge:manage` | [readStatus](/packs/knowledge/tools/#readstatus) | yes | yes |   | See who has read and confirmed each procedure, and change who must read one once published |
| `knowledge:write` | [draftProcedure](/packs/knowledge/tools/#draftprocedure), [draftHelpPage](/packs/knowledge/tools/#drafthelppage) |   | yes |   | Write procedures and help pages (a person allowed to publish publishes them) |

## Roles

This pack declares no roles.

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [toRead](/packs/knowledge/tools/#toread) | yes |   | yes |   |
| [confirm](/packs/knowledge/tools/#confirm) | yes |   | yes |   |
| [readStatus](/packs/knowledge/tools/#readstatus) | yes |   |   |   |
