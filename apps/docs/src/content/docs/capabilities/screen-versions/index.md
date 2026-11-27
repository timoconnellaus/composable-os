---
title: "Screen versions"
description: "A client's built screens stored in the host as versions that never change once sealed, checked file by file, kept apart per client."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

A client's built screens stored in the host as versions that never change once sealed, checked file by file, kept apart per client.


## What it is for

A change to a client's screens should reach its users without a deploy. The screens are built
outside the host (the client's repository and its CI) and stored in the host as a **version**: the
built files and a manifest that says what they are. A stored version changes nothing anyone sees.

## Concepts

- **Version**: the built output of a client's screens, of a **kind** (`web`, a client's web app,
  is the only one). Open while its files are sent, then **sealed** with its manifest; a sealed
  version never changes.
- **Manifest**: every file's path, SHA-256 and size, the entry (an `.html` file), the API contract
  version the screens were built against (`v1`) and what built them from what. Its shape and rules
  are `@composable-os/sdk/screen-version` (`screenVersionManifestSchema`,
  `screenVersionManifestOf`), so a build checks the same rules before it uploads.
- **File**: named by the SHA-256 of its bytes, stored once in the client's part of the files
  binding however many versions name it. Its content type is the host's, from its extension.
- **Limits**: 1000 files, 25 MB a file, 50 MB a version; paths at most 200
  characters and 10 folders deep. At most 50 versions begun and 250 MB of new files a day, and at most 3 uploads of a kind
  open at once, each removed if not
  sealed within 24 hours.

## How the pieces fit

- `core_screen_version` holds each version: its kind, open or sealed, and once sealed its
  canonical manifest, that manifest's SHA-256, its entry, contract version, file count and size,
  and who began and sealed it. `core_screen_version_file` holds a sealed version's files, exactly
  its manifest's.
- `core_screen_blob` holds each file the client holds, by hash, and where its bytes are in the
  files binding (`screens/<sha256>/<version>`, inside the client's own part on a host that serves
  many clients). `core_screen_version_upload` holds what an open version has been sent.
- Triggers on these tables refuse any change to a sealed version, its files or a file a version
  names, whatever writes the database; the operations refuse the same first.
- `core_screen_version_hold` keeps a sealed version whatever its age.
- `screenVersionFile` is the one way to find a sealed version's file, and only for a path its
  manifest names.
- All five operations need `screens:upload` (admins, or a member granted it). Only a person
  stores a version; they are staff only.

## Main flows

1. `screens.versionBegin` opens a version and says which of the build's hashes the client holds
   already.
2. Each other file is sent as the body of `PUT /api/v1/screens/versions/<id>/files/<sha256>`
   with a staff device token (`screens.versionPut`). The host hashes it and refuses it unless it
   is that hash.
3. `screens.versionSeal` takes the manifest. The host checks every path (relative, no `.` or `..`
   part, no two differing only in case, an extension it serves), the limits, the entry, and that
   every file named was sent at that size. A file sent that the manifest does not name is no part
   of the version.
4. The daily maintenance removes uploads never sealed, and sealed versions beyond the ten newest
   of their kind that nothing holds, with the files no version names.

`screens.versionList` and `screens.versionGet` read them. No operation removes a version.

## What is built

Storing, checking and keeping versions, apart per client (a client's export carries them).
Publishing a version, serving it and previewing it are not built yet.


## Reference

Generated from the code:

- [Operations](/capabilities/screen-versions/operations/)
- [Permissions](/capabilities/screen-versions/permissions/)
- [Behaviours](/capabilities/screen-versions/behaviours/)
- [Screens](/capabilities/screen-versions/screens/)
- [Decisions](/capabilities/screen-versions/decisions/)

The specification is stage 75's, [75-screen-versions.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/75-screen-versions.md).

This page is [screen-versions/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packages/core/src/screen-versions/docs/overview.md), written by hand beside the code.
