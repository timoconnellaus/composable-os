---
name: import-programs
description: Move a gym's exercise bank, class types, programs and past training onto its Composable OS host with cos programs import - import the people first, convert the old documents and spreadsheets to the programs folder (exercises.csv with keys and easier and harder versions, classtypes.csv, one .txt per program in the Programs pack's shorthand, training.csv with one row per past set), dry run until it names no problem, import, re-run safely, then have a person publish and assign. Use when asked to move a gym's or coach's programming, workouts or training history onto the host.
---

# Import programs

Describes extension contract version 1.

## When to use it

A gym's programming lives somewhere else (documents, spreadsheets, another app's export) and
should be on its host as Programs pack records: the exercise bank every program is built from, the
class types, the programs themselves, and what people did before, set by set. The import runs as a
staff member who signs in for the run, on the same door as the content and courses imports (ADR
0470). Read the "Programs" section of `docs/importing.md` in full first: it defines the folder.
This skill is the order to do it in.

## The steps

1. **Check the host has what it needs:** the Programs pack in `product.ts`'s `packs` and
   installed; you are staff, signed in as yourself.
2. **Import the people first** with the people CSV import (Settings → Import). The programs import
   finds each training row's person by email and never creates one. A row whose address no person
   has is listed with its line and left out.
3. **Write the converter** from the old material to the folder:
   - `exercises.csv`: one row per exercise of the bank, each with a `key` that stays the same
     between runs, its `measure`, and `easier` and `harder` as other rows' keys. Use the pack's
     options for `theme`, `equipment` and `body_areas`, or add the options on the host first.
   - `classtypes.csv`: the kinds of class programs are assigned to.
   - `programs/<key>.txt`: one program per file, in the pack's shorthand (`packs/programs/
     authoring.ts` documents it, and `x.programs.importText` reads the same text). Say `Kind:`
     for a client's or a course's program. An item that has both an exercise for everyone and
     levels is the exercise on the item's line with level lines under it.
   - `training.csv`: one row per set someone did, with its date, the session's name, the exercise
     (a key of `exercises.csv`, or an exercise's exact name), and what was done.

   List whatever does not convert (a superset written as prose, a test day, a body measurement) and
   say so. Never drop anything silently.
4. **Dry run:** `pnpm cos programs import <folder> --host <url> --dry-run` (add `--email <you>` for
   a code by email). Fix every problem it names (file and line) in the converter, until there are
   none. A shorthand line it cannot read is a problem: rewrite it, or make it a `*` note for
   coaches, rather than lose it. Read the rows it says matched nobody: a missing person is fixed by
   importing people.
5. **Import:** the same without `--dry-run`. Look at a program in the builder, and at one person's
   history.
6. **Re-run** after fixing the converter: nothing is made twice; a record someone edited since is
   reported as a conflict and left alone.
7. **Publish and assign:** programs come in as working copies. A person with the publish permission
   publishes them, and a coach assigns a published version to a person or a class type. Neither is
   the import's, and never an AI's own decision.

## The rules

- Past training is history: imported sessions are done, have no assignment, and are marked
  `source: import`, as are their sets. Never make an assignment to carry old training.
- What the import brings in starts no automation and sends no message. Never work around that by
  writing the records with `record.create` or a tool instead of the command.
- Never work around a refusal (an exercise not found, a line not read, an option the field does not
  have) by changing the host or the pack. Fix the folder or the people import.
- The import runs as a person. Do not look for a stored token, an API key or a staff client: there
  is none, by design (ADR 0470).

## The check

`pnpm cos programs import <folder> --host <url> --dry-run` names no problem, and a second run
without `--dry-run` reports every record unchanged.
