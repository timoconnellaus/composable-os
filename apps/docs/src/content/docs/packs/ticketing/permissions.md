---
title: "Ticketing: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `ticketing:checkin` | [checkIn](/packs/ticketing/tools/#checkin), [undoCheckIn](/packs/ticketing/tools/#undocheckin) |   |   | `ticketing.door` |   |

## Roles

### Door (`ticketing.door`)

Checks tickets in at the door and sees events, ticket types and tickets. Nothing else: no people, orders, leads or settings.

|  |  |
| --- | --- |
| Permissions | `ticketing:checkin` |
| Reads | `ticketing.event`, `ticketing.tickettype`, `ticketing.ticket` |
