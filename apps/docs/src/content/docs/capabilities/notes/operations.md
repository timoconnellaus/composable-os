---
title: "Client notes: operations"
sidebar:
  label: "Operations"
  order: 1
editUrl: false
---

The core operations that are this capability's (named `note.`, `carer.`). Each links to its full reference, with its input and output.

| Operation | What it does | Audiences | Risk | Permission |
| --- | --- | --- | --- | --- |
| [`note.open`](/reference/operations/note/#noteopen) | Open a note to read its text: a sensitive note is listed on timelines without it. Only a person who may read the note (its author, admins, and people the business named one by one) can open it; anyone else gets not found. Every opening is recorded in the audit log, without the text. Read-only. | `staff` | `read` | `records:read` |
| [`note.kinds.list`](/reference/operations/note/#notekindslist) | The kinds of note the business keeps (Note, Session note, Sensitive, From the client and its own), in the composer's order: each with its template's sections (label, hint, required), the level a note of it starts at and the levels it may have. Retired kinds are left out unless includeRetired. Read-only. | `staff` | `read` | `records:read` |
| [`note.kinds.save`](/reference/operations/note/#notekindssave) | Write a kind of note: a new one (no id), or a change to one's name, the level a note of it starts at (defaultLevel), the lowest level a note of it may have (lowestLevel) and its template (sections given whole and in order, at most 12: label, an optional hint, required). A changed level applies to notes written from now on. Needs notes:manage. An assistant's or MCP client's write always waits for a person who holds it too, and may change only the name and the template: who reads a kind's notes is a person's to set. | `staff` | `write` | `notes:manage` |
| [`note.kinds.retire`](/reference/operations/note/#notekindsretire) | Retire a kind of note (retired: true): the composer no longer offers it and its notes keep it. retired: false offers it again. Note, the kind of a note written without one, is never retired. Needs notes:manage; a person only. | `staff` | `destructive` | `notes:manage` |
| [`carer.set`](/reference/operations/carer/#carerset) | Say that a staff account looks after a person (their coach): from then on it reads the person's notes kept to their coaches, and stops when the row is ended with carer.end. Choose it on the person's page; it is never worked out from bookings. Refused when the account already looks after them. Only a person on the staff with people:link can do this: never the assistant, an MCP client or code. Audited. | `staff` | `write` | `people:link` |
| [`carer.end`](/reference/operations/carer/#carerend) | End a looks-after row (carer.list gives its id): from the next read the account no longer reads the person's notes kept to their coaches, except the ones it wrote. The row is kept, ended, with who ended it. Only a person on the staff with people:link can do this. Audited. | `staff` | `write` | `people:link` |
| [`carer.list`](/reference/operations/carer/#carerlist) | Who looks after a person (their coaches): the staff accounts that read the person's notes kept to their coaches, with who set each and when, live ones first, and (with ended) the rows that have ended. Read-only. | `staff` | `read` | `records:read` |
