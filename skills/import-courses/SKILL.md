---
name: import-courses
description: Move a studio's courses, bundles, videos and students' access and progress from a hosted course platform (LearnWorlds, Teachable, Thinkific, Kajabi) onto its Composable OS host with cos courses import - import the people first, convert the export to the courses folder (one JSON per course with each lesson's sourceId, videos by file or link, captions, access.csv, progress.csv), dry run, import as drafts, re-run until no course waits for Stream, then publish. Use when asked to migrate an online school, courses or course students onto the host.
---

# Import courses

Describes extension contract version 1.

## When to use it

A studio sells courses on a hosted platform and they should be on its host as Courses pack
records, with each student keeping what they bought, the courses they finished and where they are
in each. The import runs as a staff member who signs in for the run, as the content import does
(ADR 0470, ADR 0485). Read the "Courses" section of `docs/importing.md` in full first: it defines
the format. This skill is the order to do it in.

## The steps

1. **Check the host has what it needs:** the Courses pack and Programs in `product.ts`'s `packs`
   and installed; Stream configured (`docs/stream-runbook.md`); the published Programs programs that
   session lessons name; you are staff, with the publish permission to publish.
2. **Check the outline against two real programs** with the checklist in
   `docs/stages/42-courses.md` ("Before the first client's import"). List what does not fit (a
   quiz, a live class, nested sections) and get a decision on it before converting.
3. **Import the people first** with the people CSV import (Settings → Import). The courses import
   finds each student by email and never creates a person. A row whose address no person has is
   listed and left out.
4. **Write the converter** from the export to the folder:
   - one JSON per course, the file name its import key (the old platform's course id, kept the
     same between runs);
   - each lesson with its `sourceId`, the old platform's lesson id, which `progress.csv` names;
   - rich text in the platform's shape (`RICH_TEXT_SCHEMA`), never HTML;
   - each video as a file in `videos/` (the studio's originals) or an `https` address Stream can
     fetch (a Vimeo or Wistia download link), with captions in `captions/` (`.vtt` or `.srt`);
   - `access.csv` from the enrolments export (with `completed` for finished courses), and
     `progress.csv` when the platform exports lesson progress.

   List whatever does not convert and say so. Never drop anything silently.
5. **Dry run:** `pnpm cos courses import <folder> --host <url> --dry-run`. Fix every problem it
   names (file and line) in the converter, until there are none. Read the rows it says matched
   nothing: a missing person is fixed by importing people; a dropped lesson is a decision.
6. **Import as drafts:** the same without `--dry-run`. Large videos take a while: the command shows
   each upload's progress, then waits for Stream (`--wait <minutes>`). When it exits 3, some courses
   wait for their videos: run the same command again later until it exits 0. A re-run uploads
   nothing twice.
7. **Look** at a course in the admin, and play one lesson as an imported student.
8. **Publish:** `--publish` publishes the courses and bundles that were published on the old
   platform. It asks first (`--yes` in a script). Publishing is a person's decision: run it as the
   person who decides, never from an AI's own credential.

## The rules

- No order is invented for money taken elsewhere: access is an enrolment with source `import`.
- A student's own progress since the import is never overwritten. It is reported as a conflict.
- Never work around a refusal (a person not found, a lesson key taken, a video Stream refused) by
  changing the host. Fix the folder or the people import.
- The import runs as a person. Do not look for a stored token, an API key or a staff client: there
  is none, by design (ADR 0470).
- Never put the old platform's credentials or a Stream token in the folder or the converter's
  output.
