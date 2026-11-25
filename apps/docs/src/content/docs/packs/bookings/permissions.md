---
title: "Bookings: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `bookings:desk` | [findPeople](/packs/bookings/tools/#findpeople), [bookFor](/packs/bookings/tools/#bookfor), [cancelFor](/packs/bookings/tools/#cancelfor), [returnUse](/packs/bookings/tools/#returnuse), [day](/packs/bookings/tools/#day), [classList](/packs/bookings/tools/#classlist), [move](/packs/bookings/tools/#move), [bookAppointment](/packs/bookings/tools/#bookappointment), [moveAppointment](/packs/bookings/tools/#moveappointment), [cancelAppointment](/packs/bookings/tools/#cancelappointment), [markAppointment](/packs/bookings/tools/#markappointment), [excuseAppointment](/packs/bookings/tools/#excuseappointment), [coachDay](/packs/bookings/tools/#coachday) |   | yes |   | Front desk: find people, book anyone (walk-ins too) into any class, cancel or move their bookings, give a use back, and see any day's classes and full lists. For a coach who also works the desk. |
| `bookings:coach` | [day](/packs/bookings/tools/#day), [roster](/packs/bookings/tools/#roster), [markAttended](/packs/bookings/tools/#markattended), [undoAttended](/packs/bookings/tools/#undoattended), [markNoShow](/packs/bookings/tools/#marknoshow), [markAll](/packs/bookings/tools/#markall) |   |   | `bookings.coach` |   |
| `bookings:cancelClasses` | [cancelClass](/packs/bookings/tools/#cancelclass) |   |   |   |   |
| `bookings:appointments` | [bookAppointment](/packs/bookings/tools/#bookappointment), [moveAppointment](/packs/bookings/tools/#moveappointment), [cancelAppointment](/packs/bookings/tools/#cancelappointment), [cancelAppointmentByUs](/packs/bookings/tools/#cancelappointmentbyus), [markAppointment](/packs/bookings/tools/#markappointment), [excuseAppointment](/packs/bookings/tools/#excuseappointment), [reassignAppointment](/packs/bookings/tools/#reassignappointment), [coachDay](/packs/bookings/tools/#coachday) |   | yes |   | Appointments: book one-to-one sessions for clients, move, cancel and mark them, give a session back, give a session to another coach, and see any coach's day. For a coach who manages the others' sessions. |

## Roles

### Coach (`bookings.coach`)

Sees the day's classes and each class's list, and ticks who came (or marks who did not). Nothing else: no money, no other people, no booking or cancelling, no settings.

|  |  |
| --- | --- |
| Permissions | `bookings:coach` |
| Reads | `bookings.class` |
| Only today's | `bookings.class`, `bookings.booking` |

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [returnUse](/packs/bookings/tools/#returnuse) | yes |   |   |   |
| [cancelClass](/packs/bookings/tools/#cancelclass) |   | yes |   |   |
| [cancelAppointmentByUs](/packs/bookings/tools/#cancelappointmentbyus) |   | yes |   |   |
| [excuseAppointment](/packs/bookings/tools/#excuseappointment) | yes |   |   |   |
| [reassignAppointment](/packs/bookings/tools/#reassignappointment) |   | yes |   |   |
