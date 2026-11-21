# Importing content

`cos content import` loads posts and their pictures from another system (an old blog) into a
host, as the person who runs it. It is the platform's door for writing content from a script
([ADR 0470](adr/0470-the-import-door.md)): every write is an operation that person's session calls,
checked and audited as theirs.

```bash
cos content import ./export --host https://admin.example.com              # by the browser
cos content import ./export --host https://admin.example.com --email you@example.com
cos content import ./export --host https://admin.example.com --dry-run    # checks, writes nothing
cos content import ./export --host https://admin.example.com --publish    # asks, then publishes
cos content import ./export --host https://admin.example.com --publish --yes   # from a script
```

## What it does

1. Reads the folder and checks every post and picture (below). Any problem stops the run before
   anyone signs in, with each problem and its file.
2. Signs you in for this run only: with `--email`, the host emails a staff code (the host's own
   sign-in); without it, your browser opens the host's staff sign-in (Cloudflare Access, Google)
   and hands a one-time code back to a port on `127.0.0.1` the command listens on. The session is
   held in the command's memory, nowhere else, and ended on the host when the run finishes. No
   token is read from a file or the environment, or printed.
3. Checks every record on the host as it would be written (`record.import` with `dryRun`): the
   host's own field rules. A problem here stops the run too, with nothing written.
4. Uploads the pictures the library does not have (by the SHA-256 of their bytes), then writes
   the categories and the posts. With `--dry-run` it stops before this and says what would
   happen.
5. With `--publish`, after asking (or with `--yes`): publishes each post whose `status` is
   `published`, and schedules each `scheduled` one for its `date` (one whose time has passed is
   published). Without `--publish`, every post is a draft, and the report says which were
   published or scheduled in the source.

Run it again whenever you like. A post is matched by its **import key** (below), not its title:

- a key seen before whose record still holds what the import wrote: the fields the source changed
  are updated, and nothing else; unchanged, nothing is written;
- a record someone has edited since the import (any field the import wrote), or deleted: a
  **conflict**, reported with the fields, and left as it is;
- a new key whose address (slug) another post already has: a conflict, never a second post;
- a published post publishes again only when its content changed.

Pictures are never uploaded twice: the library knows each file by its hash.

## The folder

```
export/
  opening-night.json      one post per file; the file name (without .json) is its import key
  second-week.json
  pictures/
    hall.jpg              the pictures the posts name, by file name
    cover.png
```

A post file is one JSON object:

| Field | | What |
| --- | --- | --- |
| `key` | optional | The import key. Default: the file name without `.json`. 1 to 200 letters, digits or `._:-`. Keep it the same between runs. |
| `title` | required | Text, at most 1,000 characters. |
| `slug` | optional | The address: lowercase letters and digits in words joined by hyphens (`opening-night`). Default: made from the title. Two posts may not share one. |
| `excerpt` | optional | Text. |
| `body` | optional | Rich text in the platform's own shape (`RICH_TEXT_SCHEMA`, ADR 0440), with one difference: a picture block names its file, `{ "type": "image", "file": "hall.jpg", "alt": "…" }`, where the stored shape has `media`. |
| `cover` | optional | `{ "file": "cover.png", "alt": "…", "focal": { "x": 0.5, "y": 0.3 } }` (`focal` optional, 0 to 1). |
| `date` | optional | ISO 8601 date and time with its zone (`2021-03-01T09:00:00Z`): the date readers are shown. Kept when published, so old posts keep their dates and the public list stays in their order. |
| `status` | optional | `draft` (default), `scheduled` (needs `date`) or `published`. Acted on only with `--publish`. |
| `category` | optional | The category's name. Categories are made from the names, once each. |
| `byline` | optional | Who wrote it, as readers see it (`Words by Sam Lee`). |
| `seoTitle` | optional | The title for search engines and link previews. |
| `seoDescription` | optional | The description for them. |
| `seoImage` | optional | The share picture, as `cover`. |
| `noindex` | optional | `true` asks search engines not to list the post. |

Any other field is a problem. A picture must be in `pictures/`, a JPEG, PNG, GIF, WebP or AVIF by
its bytes (not its name), at most 10 MB; SVG is not taken.

Example:

```json
{
  "title": "Opening night",
  "slug": "opening-night",
  "excerpt": "Doors at seven.",
  "body": {
    "blocks": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "The hall was full." }] },
      { "type": "image", "file": "hall.jpg", "alt": "The hall from the stage" }
    ]
  },
  "cover": { "file": "cover.png", "alt": "The stage" },
  "date": "2021-03-01T09:00:00Z",
  "status": "published",
  "category": "News",
  "byline": "Words by Sam Lee",
  "seoTitle": "Opening night at the hall",
  "seoDescription": "How the first night went.",
  "noindex": false
}
```

## What the host needs

- The Content pack installed (`content.post`, `content.category`).
- You are a staff member. Publishing needs the publish permission (admins have it; an admin grants
  it to a member).
- For the browser sign-in, the host lists the command's loopback address in
  `NATIVE_REDIRECT_URIS`: add `http://127.0.0.1/cos-sign-in` (no port: the command picks one each
  run). A host that signs staff in by code needs nothing for `--email`.
- Behind Cloudflare Access nothing else: the command calls `/api/v1/*` (the HTTP surface, already
  bypassed) and uploads to `POST /api/v1/media`, which takes a staff device token only
  ([docs/deploying.md](deploying.md#what-stays-behind-access-and-what-is-bypassed)).

## On a post's page

The pack's `postHead(post, { siteName, url, origin })` (from `@composable-os/pack-content/client`)
gives a published post's head: its title (the search title, else the title), description (else
the excerpt, else the start of the body), share picture (else the cover), canonical address and
`noindex`. The `content-post` block's `PostHead` renders it as React 19 `<title>` and `<meta>`
elements, which React hoists into the document's head. In TanStack Start, render `<PostHead>`
beside `<PostArticle>`, or return the same values from the route's `head()`. In an Astro page,
call `postHead()` in the frontmatter and write the tags in `<head>`:

```astro
---
const answer = await host.call("content.get", { object: "content.post", slug: Astro.params.slug });
const head = postHead(answer, { siteName: "The Hall", url: Astro.url.href, origin: Astro.url.origin });
---
<head>
  <title>{head.title}</title>
  {head.description && <meta name="description" content={head.description} />}
  {head.image && <meta property="og:image" content={head.image.url} />}
  {head.robots && <meta name="robots" content={head.robots} />}
  {head.canonical && <link rel="canonical" href={head.canonical} />}
</head>
```
