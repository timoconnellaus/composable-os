---
title: "Screen versions: operations"
sidebar:
  label: "Operations"
  order: 1
editUrl: false
---

The core operations that are this capability's (named `screens.version`). Each links to its full reference, with its input and output.

| Operation | What it does | Audiences | Risk | Permission |
| --- | --- | --- | --- | --- |
| [`screens.versionBegin`](/reference/operations/screens/#screensversionbegin) | Begin storing a new version of the client's screens (a build made outside the host, by its repository's CI or a person's machine). Returns the open version's id, when it is swept unless sealed (24 hours), the limits of a version, and which of the files' hashes you name the client already holds, so those are not sent again. Then send each other file to the upload route (screens.versionPut) and seal it with its manifest (screens.versionSeal). Changes nothing anyone sees: a version is published only by screens.publish. | `staff` | `write` | `screens:upload` |
| [`screens.versionPut`](/reference/operations/screens/#screensversionput) | Store one file of an open screen version, named by the SHA-256 of its bytes (lowercase hex). The file comes from the upload route, never this input; it is hashed on arrival and refused unless it is that hash, or past a version's limits (a file at most 25 MB, a version at most 1000 files and 50 MB). A file the client holds already is not stored again. Putting the same file twice is harmless. | `staff` | `write` | `screens:upload` |
| [`screens.versionSeal`](/reference/operations/screens/#screensversionseal) | Seal an open screen version with its manifest: the files (each path, SHA-256 and size), the entry (an .html file among them), the API contract version it was built against (v1) and what built it from what (a tool, and a repository, commit or ref; never a person's name). The host checks every path (relative, no . or .. part, no two differing only in case, an extension it serves), the limits, the entry, and that every file named is one the client holds at that size. Sealed, the version is exactly its manifest's files and never changes; a file it was sent that the manifest does not name is no part of it. Sealing publishes nothing (screens.publish does). | `staff` | `write` | `screens:upload` |
| [`screens.versionList`](/reference/operations/screens/#screensversionlist) | The client's screen versions of one kind (web: its web app), newest first: each one's state (open while its files are uploaded, sealed once it is checked and fixed), who began and sealed it, its entry, the API contract version it was built against, its file count and size, and its manifest's hash. Read-only. The last ten sealed versions of a kind are always kept, and any version held. | `staff` | `read` | `screens:upload` |
| [`screens.versionGet`](/reference/operations/screens/#screensversionget) | One screen version: what screens.versionList says of it, and for a sealed version its manifest and its files (each path, SHA-256, size and the content type the host serves it with); for an open one, the files it has been sent so far. Read-only. | `staff` | `read` | `screens:upload` |
