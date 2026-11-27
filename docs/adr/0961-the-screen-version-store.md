# ADR 0961: The screen version store

Status: accepted, 2026-11-27 (stage 75 step 3, the build). Builds on
[ADR 0960](0960-screens-as-published-versions-and-one-desktop-app.md),
[ADR 0611](0611-one-host-a-database-per-client.md),
[ADR 0615](0615-every-entry-decides-the-client.md) (the files binding's `clients/<client>/`
prefix), [ADR 0444](0444-media-the-editor-and-the-content-pack.md) (bytes from a route, never an input) and
[ADR 0470](0470-the-import-door.md) (a staff device token for a script's uploads).

## Context
Stage 75 stores a client's built screens as versions, publishes one, and serves it on the web and
in the desktop app. Step 3 is the store: how a version gets in, what is checked, where it is kept,
that it never changes, how it is removed, and that one client's versions are out of another's
reach. The host stores and checks; it never builds (the spec). The store must not depend on how
a version is served (Worker Loader, a namespace upload, the desktop app).

A version is many files, some large. An operation's input is JSON that the audit log, an approval
and MCP see, inside the HTTP surface's 1 MB body; a file's bytes cannot be one.

## Decision
- **The manifest is one shape in one place:** `@composable-os/sdk/screen-version`
  (`screenVersionManifestSchema`, `ScreenVersionManifest`, `screenVersionManifestOf`,
  `canonicalScreenVersionManifest`, `SCREEN_VERSION_LIMITS`, `screenPathProblem`,
  `screenContentType`), so a build and the host check the same rules. It holds `format`
  (`cos-screens/1`), `entry`, `contract` (the API contract version, `v1`), `files` (each `path`,
  `sha256`, `size`) and `build` (`tool`, and `from`: a repository, commit or ref). It is strict:
  an unknown key is refused.
- **Three steps, so no operation carries a file:** `screens.versionBegin` opens a version (and
  says which of the build's hashes the client holds already, so those are not sent again);
  each file goes to `PUT /api/v1/screens/versions/<id>/files/<sha256>` as the request's body,
  which hands it to `screens.versionPut` as `ctx.upload`; `screens.versionSeal` takes the
  manifest. The route takes a staff device token only, never a cookie, as `cos content import`'s
  uploads do, and the client-app binding does not mount it. `screens.versionPut` is
  `neverQueued`: a call the policy or the deploy floor would make wait is refused, since a
  pending action could not hold the bytes.
- **The checks.** On arrival a file is hashed and refused unless it is the hash it was sent as
  ("a changed file is refused"), and unless it fits the limits. At seal: the manifest's shape; every
  path relative, of letters, digits and `. _ - ~ @ +` only, no `.` or `..` part, no empty part,
  at most 200 characters and 10 folders deep, with an extension the host serves; no two paths
  differing only in case and no file that is another's folder (a version is unpacked onto disks
  that fold case); the entry an `.html` file among them; and every file one the client holds at
  the manifest's size. Content types are the host's, from the extension; a manifest that names
  one is refused. A file the version was sent that the manifest does not name is no part of it
  (the seal's answer lists it as `unused`, and the sweep removes it).
- **Limits:** at most 1000 files, 25 MB a file (Cloudflare's limit for a static asset, so a
  version is also servable as one), 50 MB a version (so a manifest is at most about 330 KB,
  inside the surface's 1 MB body); at most 3 versions of a kind open at once, each swept 24 hours
  after it was begun. A client's unsealed bytes are so at most 150 MB a kind, gone within a day.
- **Where it lives.** Records in the client's database (migration 1490):
  `core_screen_version` (open, then sealed with its canonical manifest, its SHA-256 and what it
  says), `core_screen_version_file` (a sealed version's files, exactly its manifest's, with the
  host's content type), `core_screen_blob` (each file the client holds, by hash, once whatever
  number of versions name it), `core_screen_version_upload` (what an open version was sent) and
  `core_screen_version_hold`. Bytes in the files binding under `screens/<sha256>/<the version that
  first stored it>`, which a many-client host keeps in `clients/<client>/` (ADR 0615). A version
  is per environment, since an environment has its own database.
- **A sealed version never changes, whatever writes the database.** Triggers refuse a version
  stored sealed, any change to a sealed version, a file added to anything but an open version or
  naming a file the client does not hold at that size, any change to a version's files, their
  removal while the version exists, a change to a held file's hash, size or place, and the
  removal of a file a version names. The seal's own trigger checks the version's count, bytes
  and entry against its files. The operations refuse the same first, with plain answers.
  `query.sql` reaches no core table.
- **Removal is the retention rule only.** No operation removes a version. The daily maintenance
  sweep (`sweepScreenVersions`, per client) ends holds whose `until` has passed, removes open
  versions past their time with what they were sent, and removes sealed versions beyond the ten
  newest of their kind that nothing holds; the delete trigger refuses one of the ten newest of
  its kind or a held one.
  Files no version names and no open version claims are queued in `core_blob_deletion` in the
  same batch that removes their rows (drained by the 10-minute cron); objects under `screens/`
  no row names (a put whose batch failed) are deleted once their version is not open.
- **The seam step 4 fills:** a row in `core_screen_version_hold` keeps a sealed version whatever
  its age. Step 4 writes one (`reason` `published`, `until` null) for the published version, and
  when the pointer moves sets its `until` to 90 days on: "any version published in the last 90
  days" with no code in the sweep that knows about publishing.
- **Who may.** A new permission, `screens:upload` (admins; grantable, so a member who builds the
  screens may be given it). People only (`actors: ["human"]`): storing a draft is lower risk than
  publishing (it changes nothing anyone sees), but no AI caller can send a file's bytes here and
  nothing needs one to: versions come from a client's repository and its CI, sent by `cos` with
  a person's staff device token (step 7). The writes are hidden from MCP; the reads (`screens.versionList`, `screens.versionGet`)
  are open to any staff actor with the permission. Staff only: no customer or public caller.
- **A version has a kind:** what it is the built output of. One value now, `web` (a client's web
  app), checked by the operations (`SCREEN_VERSION_KINDS`) and by the table's CHECK. Retention
  (the ten newest sealed are kept per kind), the bound on open uploads and listing are per client
  and kind. No second kind is planned now; the column is kept as room for other built output
  later, in the same store with its own published pointer: step 4's pointer can be per client,
  environment and kind, and adding a kind is a migration that widens the CHECK, not a redesign.
- **Who built it** is the host's record: the staff user who began and who sealed it. The manifest
  names a tool and a source, never a person, so an erase never has to change a sealed version.
- **Reserved, not built: a signature.** The desktop wrapper (stage 76) checks a signed manifest.
  What it signs is the canonical manifest, whose SHA-256 is recorded at seal; a signature is a
  record of its own beside the version, so adding one never changes a sealed version. Nothing
  signs yet.
- **The contract version is recorded and its shape checked** (`v<n>`); refusing one the host does
  not serve is `screens.publish`'s (step 4, criterion 5).
- **Serving reads one function:** `screenVersionFile(db, version, path)` answers a sealed
  version's file (hash, size, content type, where its bytes are) only for a path its manifest
  names. It knows nothing of Cloudflare's loader.

## Why
- Bytes beside the surface, by hash, keep operations small and audited and let a re-run send only
  what changed; hashing on arrival makes the hash the only name a file has.
- The client's own database and its own prefix are what stage 66 already keeps apart, exports and
  erases: a version needed no new rule of separation. A hash another client stored names nothing
  in this client's database or prefix.
- A key per storing version (not per hash) means a file removed and put again never shares a key
  with a deletion still queued for the old one.

## Consequences
- A client's export (`cos client export`, stage 66 step 7) carries its versions: the database
  (every `core_*` table, triggers made after the rows) and every file under the client's prefix.
  The round trip of a sealed version and its triggers is tested in `sql-export.test.ts`.
- `staff.json` grows by five operations.
- Not built here: the pointer and `screens.publish` (step 4), serving (step 5), preview (step 6),
  the `cos` command that builds the manifest and uploads (step 7).
