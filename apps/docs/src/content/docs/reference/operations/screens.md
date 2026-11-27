---
title: "screens.* operations"
description: "The core operations named screens.*"
sidebar:
  label: "screens"
editUrl: false
---

## screens.mine

The staff screens of the installed packs the signed-in person may open in the admin: each one's pack, key, label, where it sits in the navigation, its route, and the object whose record page shows it as a tab. A screen is listed only when the person could call every tool that gates it. Empty for anyone but a person. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `screens` | array of object | yes |   |   |
| `screens[].pack` | string | yes |   |   |
| `screens[].key` | string | yes |   |   |
| `screens[].label` | string | yes |   |   |
| `screens[].nav` | object or null | yes |   |   |
| `screens[].nav.group` | string | yes |   |   |
| `screens[].nav.order` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `screens[].route` | string | yes |   |   |
| `screens[].record` | object or null | yes |   |   |
| `screens[].record.object` | string | yes |   |   |
| `screens[].record.as` | string | yes |   |   |

## screens.versionBegin

Begin storing a new version of the client's screens (a build made outside the host, by its repository's CI or a person's machine). Returns the open version's id, when it is swept unless sealed (24 hours), the limits of a version, and which of the files' hashes you name the client already holds, so those are not sent again. Then send each other file to the upload route (screens.versionPut) and seal it with its manifest (screens.versionSeal). Changes nothing anyone sees: a version is published only by screens.publish.

|  |  |
| --- | --- |
| Permission | `screens:upload` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"web"` |   | default `"web"` | What the version is the built output of: web, a client's web app |
| `sha256` | array of string |   | at most 1000, default `[]` | The hashes of the build's files, to learn which the client already holds |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"web"` | yes |   | What the version is the built output of: web, a client's web app |
| `expiresAt` | string | yes |   |   |
| `limits` | object | yes |   |   |
| `limits.maxFiles` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `limits.maxFileBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `limits.maxTotalBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `limits.maxPathLength` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `limits.maxPathDepth` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `held` | array of string | yes |   | The hashes given that the client holds: do not send them |

## screens.versionGet

One screen version: what screens.versionList says of it, and for a sealed version its manifest and its files (each path, SHA-256, size and the content type the host serves it with); for an open one, the files it has been sent so far. Read-only.

|  |  |
| --- | --- |
| Permission | `screens:upload` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes | pattern `^scv_[0-9A-HJKMNP-TV-Z]{26}$` | The version's id (scv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"web"` | yes |   | What the version is the built output of: web, a client's web app |
| `state` | `"open"`, `"sealed"` | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string | yes |   | The staff user who began it |
| `expiresAt` | string or null | yes |   | Open: when it is swept unless sealed |
| `sealedAt` | string or null | yes |   |   |
| `sealedBy` | string or null | yes |   | The staff user who sealed it |
| `entry` | string or null | yes |   |   |
| `contract` | string or null | yes |   | The API contract version it was built against |
| `buildTool` | string or null | yes |   |   |
| `fileCount` | integer or null | yes |   |   |
| `totalBytes` | integer or null | yes |   |   |
| `manifestSha256` | string or null | yes |   | The SHA-256 of its canonical manifest |
| `manifest` | any or null | yes |   | The canonical manifest, once sealed |
| `files` | array of object | yes |   |   |
| `files[].path` | string | yes |   |   |
| `files[].sha256` | string | yes |   |   |
| `files[].size` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `files[].contentType` | string | yes |   |   |
| `received` | array of object | yes |   |   |
| `received[].sha256` | string | yes |   |   |
| `received[].size` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## screens.versionList

The client's screen versions of one kind (web: its web app), newest first: each one's state (open while its files are uploaded, sealed once it is checked and fixed), who began and sealed it, its entry, the API contract version it was built against, its file count and size, and its manifest's hash. Read-only. The last ten sealed versions of a kind are always kept, and any version held.

|  |  |
| --- | --- |
| Permission | `screens:upload` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"web"` |   | default `"web"` | What the version is the built output of: web, a client's web app |
| `state` | `"open"`, `"sealed"` |   |   | Only versions in this state |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versions` | array of object | yes |   |   |
| `versions[].id` | string | yes |   |   |
| `versions[].kind` | `"web"` | yes |   | What the version is the built output of: web, a client's web app |
| `versions[].state` | `"open"`, `"sealed"` | yes |   |   |
| `versions[].createdAt` | string | yes |   |   |
| `versions[].createdBy` | string | yes |   | The staff user who began it |
| `versions[].expiresAt` | string or null | yes |   | Open: when it is swept unless sealed |
| `versions[].sealedAt` | string or null | yes |   |   |
| `versions[].sealedBy` | string or null | yes |   | The staff user who sealed it |
| `versions[].entry` | string or null | yes |   |   |
| `versions[].contract` | string or null | yes |   | The API contract version it was built against |
| `versions[].buildTool` | string or null | yes |   |   |
| `versions[].fileCount` | integer or null | yes |   |   |
| `versions[].totalBytes` | integer or null | yes |   |   |
| `versions[].manifestSha256` | string or null | yes |   | The SHA-256 of its canonical manifest |

## screens.versionPut

Store one file of an open screen version, named by the SHA-256 of its bytes (lowercase hex). The file comes from the upload route, never this input; it is hashed on arrival and refused unless it is that hash, or past a version's limits (a file at most 25 MB, a version at most 1000 files and 50 MB). A file the client holds already is not stored again. Putting the same file twice is harmless.

|  |  |
| --- | --- |
| Permission | `screens:upload` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes | pattern `^scv_[0-9A-HJKMNP-TV-Z]{26}$` | The version's id (scv_…) |
| `sha256` | string | yes | pattern `^[0-9a-f]{64}$` | The file's SHA-256 |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sha256` | string | yes |   |   |
| `size` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `stored` | boolean | yes |   | False when the client held this file already |

## screens.versionSeal

Seal an open screen version with its manifest: the files (each path, SHA-256 and size), the entry (an .html file among them), the API contract version it was built against (v1) and what built it from what (a tool, and a repository, commit or ref; never a person's name). The host checks every path (relative, no . or .. part, no two differing only in case, an extension it serves), the limits, the entry, and that every file named is one the client holds at that size. Sealed, the version is exactly its manifest's files and never changes; a file it was sent that the manifest does not name is no part of it. Sealing publishes nothing (screens.publish does).

|  |  |
| --- | --- |
| Permission | `screens:upload` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes | pattern `^scv_[0-9A-HJKMNP-TV-Z]{26}$` | The version's id (scv_…) |
| `manifest` | object | yes |   | The manifest the build wrote |
| `manifest.format` | `"cos-screens/1"` | yes |   |   |
| `manifest.entry` | string | yes | max length 200 |   |
| `manifest.contract` | string | yes | pattern `^v[1-9][0-9]{0,3}$` |   |
| `manifest.files` | array of object | yes | at least 1, at most 1000 |   |
| `manifest.files[].path` | string | yes | max length 200 |   |
| `manifest.files[].sha256` | string | yes | pattern `^[0-9a-f]{64}$` |   |
| `manifest.files[].size` | integer | yes | ≥ 0, ≤ 26214400 |   |
| `manifest.build` | object | yes |   |   |
| `manifest.build.tool` | string | yes | min length 1, max length 100 |   |
| `manifest.build.from` | object |   |   |   |
| `manifest.build.from.repository` | string |   | min length 1, max length 300 |   |
| `manifest.build.from.commit` | string |   | pattern `^[0-9a-f]{7,64}$` |   |
| `manifest.build.from.ref` | string |   | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"web"` | yes |   | What the version is the built output of: web, a client's web app |
| `state` | `"open"`, `"sealed"` | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string | yes |   | The staff user who began it |
| `expiresAt` | string or null | yes |   | Open: when it is swept unless sealed |
| `sealedAt` | string or null | yes |   |   |
| `sealedBy` | string or null | yes |   | The staff user who sealed it |
| `entry` | string or null | yes |   |   |
| `contract` | string or null | yes |   | The API contract version it was built against |
| `buildTool` | string or null | yes |   |   |
| `fileCount` | integer or null | yes |   |   |
| `totalBytes` | integer or null | yes |   |   |
| `manifestSha256` | string or null | yes |   | The SHA-256 of its canonical manifest |
| `unused` | array of string | yes |   | Hashes the version was sent that the manifest does not name: not part of it |
