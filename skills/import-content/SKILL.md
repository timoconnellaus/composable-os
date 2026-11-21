---
name: import-content
description: Load a company's existing blog posts and their pictures into its Composable OS host with cos content import - convert the old system's posts to the import folder format (one JSON per post in the platform's rich text shape, pictures by file name), check it with --dry-run, import as drafts, then publish with their original dates. Use when asked to move a blog, news or articles from another system (WordPress, EmDash, Ghost, a CMS export) onto the host.
---

# Import content

Describes extension contract version 1.

## When to use it

A company's posts live somewhere else and should be on its host as Content pack posts
(`content.post`), with their addresses, dates, pictures, bylines and search fields kept. The
import is the platform's door for this: it runs as a staff member who signs in for the run, so
every write is theirs and checked like any other. Read `docs/importing.md` in full first: it is
the format's definition.

## The steps

1. **Check the host has what it needs:** the Content pack in `product.ts`'s `packs` and
   installed; the person running it is staff (and holds the publish permission to publish); for
   a browser sign-in, `http://127.0.0.1/cos-sign-in` in the host's `NATIVE_REDIRECT_URIS`.
2. **Write the converter** from the old system to the folder: one JSON file per post (its file
   name is the post's import key: keep it the same between runs, such as the old system's id),
   and a `pictures/` folder. Write rich text in the platform's shape (`RICH_TEXT_SCHEMA` in
   `@composable-os/sdk`), never HTML: map each element to a block, a picture block with `file`
   in place of `media`. Validate each body with `validateDocument(RICH_TEXT_SCHEMA, body)` (with
   placeholder media ids). List whatever does not convert and say so; never drop it silently.
3. **Dry run:** `pnpm cos content import <folder> --host <url> --dry-run` (add `--email <you>`
   for a code by email). Fix every problem it names, with its file, until there are none.
4. **Import as drafts:** the same without `--dry-run`. Look at a few posts in the admin.
5. **Publish:** `--publish` publishes the `published` posts with their own dates and schedules the
   `scheduled` ones; it asks first (`--yes` in a script). Publishing is a person's decision: run
   it as the person who decides, never from an AI's own credential.
6. **Re-run** after fixing the converter: nothing is made twice; a post someone edited since is
   reported as a conflict and left alone.

## The rules

- Never write HTML into a post, and never store a picture as a URL to the old site: upload it
  through the import.
- Never work around a refusal (a slug taken, a picture refused) by changing the host: fix the
  folder.
- The import runs as a person. Do not look for a stored token, an API key or a staff client: there
  is none, by design (ADR 0470).
