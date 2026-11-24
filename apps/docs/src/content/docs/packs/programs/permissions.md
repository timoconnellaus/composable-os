---
title: "Programs: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `programs:coach` | [today](/packs/programs/tools/#today), [sessionGet](/packs/programs/tools/#sessionget), [logAdd](/packs/programs/tools/#logadd), [logUpdate](/packs/programs/tools/#logupdate), [sessionComplete](/packs/programs/tools/#sessioncomplete), [history](/packs/programs/tools/#history), [progress](/packs/programs/tools/#progress) |   |   | `programs.coach` |   |

## Roles

### Coach (`programs.coach`)

Sees the clients they coach (an active program naming them their coach): their sessions, sets, history and progress, and logs sets and marks sessions for them. Nothing else: no other clients, no class sessions, no programs, no assigning, no people.

|  |  |
| --- | --- |
| Permissions | `programs:coach` |
| Reads | `programs.assignment`, `programs.session` |
| Only the People its holder looks after | `programs.assignment`, `programs.session`, `programs.log` |
