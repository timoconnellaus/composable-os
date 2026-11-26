---
title: "Client notes"
description: "Notes staff keep about a person, each with a kind and a level that decides who reads it, written from the kind's template."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

Notes staff keep about a person, each with a kind and a level that decides who reads it, written from the kind's template.


## What it is for

Staff keep notes about a person: a coach's session note after a class, a goal set at intake, an
injury the client mentioned. Most notes are for the whole staff. Some are for the people who look
after that client and their managers, and a few are sensitive: only their author and the people the
business named one by one may open them, and every opening is recorded. The host decides who reads
each note on every read, for every path and every actor; no AI reads a note kept from the whole
staff.

A note is an activity of type `note`: it sits on the person's timeline beside emails, calls and
meetings, and on the timeline of anything else it is linked to (a class, a deal).

## Concepts

- **Level**: who may read a note. `staff` (every staff account), `coaches` (its author, the staff
  who look after its one person, admins and holders of `notes:clients`) or `sensitive` (its
  author, admins and holders of `notes:sensitive`; listed without its text and opened with
  `note.open`, each opening audited). A note above `staff` is about exactly one person.
- **Kind**: the business's kinds of note (Note, Session note, Sensitive, From the client and its
  own). A kind has a template of labelled sections, the level a note of it starts at and the lowest
  level one may ever have. A retired kind is no longer offered and keeps its notes.
- **Looks after**: a staff account set on a person's page as one of their coaches. It reads the
  person's `coaches` notes while the row is live.
- **Record file**: a photo (JPEG, PNG or WebP, at most 10 MB) or a PDF (at most 20 MB) attached
  to a note of a kind that takes files, at most 20 a note. Its type is read from its bytes and a
  picture's location, camera and other metadata are removed before it is kept. It is served only
  to a person who may read its note at that moment; anyone else gets the same not-found.
- **The notes permissions**: `notes:clients`, `notes:sensitive` and `notes:manage`, held by admins
  and given to others one by one by a human admin, never to oneself. They give an AI nothing, except
  that an AI acting for a holder of `notes:manage` may draft a kind's name and template, which waits
  for a person who holds it.

## How the pieces fit

- `core_activity` holds the note, its level, its kind and the template's sections as filled in.
  Notes above `staff` are kept out of `core_base_activities`, the `rec_activity` views and search,
  so SQL, dashboards, exports, embeddings and summaries never see them.
- The visibility seam (`visibility/notes.ts`) adds back the ones the caller may read, on every
  read of `activity.*` and `note.open`.
- `core_note_kind` holds the kinds; `note.kinds.list`, `.save` and `.retire` keep them. The
  operations and database triggers hold every note at or above its kind's lowest level.
- `core_person_carer` holds who looks after whom; `carer.set`, `.end` and `.list` keep it.
- `core_record_file` holds a note's files; their bytes are in R2 under `files/`, never in the
  media library. `POST /api/files` asks `file.checkUpload` before reading the body, then
  `file.upload` stores the file once its row commits. An upload made before its note is saved
  waits for `activity.log`'s `files` and is deleted the next day if no note takes it.
  `GET /api/files/<id>` streams what `file.serve` allows, with headers that stop a file running as
  a page. `file.delete` removes one; `file.storage.get` and `file.storage.setCap` give the total
  and keep the limit. Every file operation is a person's, staff only, and not on MCP.
- The composer blocks (`web-note-composer`, `native-note-composer`) and the admin's own timeline
  use the notes entry of `@composable-os/client`: the kinds and levels the host lists, and a draft
  that only says what is empty before the host checks the note in full.

## Main flows

- **A session note.** A coach opens the composer on a member, picks Session note, fills in Worked
  on, How it went and Next time, and saves. The host makes the note's body from the sections, keeps
  it at the kind's level (`coaches`) and audits each later read of its text with the note's id.
- **A sensitive note.** Any staff writer picks Sensitive and writes it; it can never be lowered
  below sensitive. Others who may read it see a locked row and open it one at a time.
- **Keeping the kinds.** In Settings → Notes a person holding `notes:manage` adds a kind, sets its
  template and its levels, or retires one. An assistant may draft a kind's name and template; its
  change waits for a person who holds `notes:manage`, and it never sets a level.
- **Who looks after whom.** On a person's page someone with `people:link` adds or ends a staff
  account in Looks after; it takes effect on the next read.
- **A photo on a note.** A person uploads a photo to `/api/files`, then saves the note with the
  file's id in `files`; a note may be its files alone. The note's readers see the file's name,
  type and size on the note and open it at `/api/files/<id>`; a serve of a file on a note kept from
  the whole staff is recorded in the audit log by id. In the Trash the note serves no file; purged,
  its files go, and erasing a person deletes the files of every note about them.

## What is built

Levels, the note scope, looks after, the three permissions, kinds and templates, Settings → Notes
(with a kind's files and the storage total and limit), the admin's composer and timeline, the
composer blocks, and record files with their upload and serve routes. A file picker in the
composer, sharing a note with the client, the client's own uploads, the coach's class list, and
evidence and retention for notes are later steps of stage 56.


## Reference

Generated from the code:

- [Operations](/capabilities/notes/operations/)
- [Permissions](/capabilities/notes/permissions/)
- [Behaviours](/capabilities/notes/behaviours/)
- [Screens](/capabilities/notes/screens/)
- [Decisions](/capabilities/notes/decisions/)

The specification is stage 56's, [56-client-notes.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/56-client-notes.md).

This page is [notes/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packages/core/src/notes/docs/overview.md), written by hand beside the code.
