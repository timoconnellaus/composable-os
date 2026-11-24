---
title: "media.* operations"
description: "The core operations named media.*"
sidebar:
  label: "media"
editUrl: false
---

## media.captionDelete

Remove one video's caption track in a language.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `language` | string | yes | pattern `^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$` | The caption's language, a BCP 47 tag: en, pt-BR |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `language` | string | yes |   |   |

## media.captionGenerate

Ask Cloudflare Stream to generate a caption track for a ready video in a language it supports. Stream charges for it, so it is refused until an admin has turned generated captions on (media.settings.update). The track is `processing` until media.videoRefresh finds it ready. A person only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `language` | string | yes | pattern `^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$` | The caption's language, a BCP 47 tag: en, pt-BR |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `language` | string | yes |   |   |
| `label` | string | yes |   |   |
| `generated` | boolean | yes |   |   |
| `state` | `"processing"`, `"ready"`, `"failed"` | yes |   |   |

## media.captionUpload

Add or replace one video's caption track in a language, from a WebVTT file a person uploaded (at most 10 MB; an .srt is converted first). The file comes from the upload route, not from this input.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `language` | string | yes | pattern `^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$` | The caption's language, a BCP 47 tag: en, pt-BR |
| `label` | string |   | min length 1, max length 100 | Shown in the player: English |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `language` | string | yes |   |   |
| `label` | string | yes |   |   |
| `generated` | boolean | yes |   |   |
| `state` | `"processing"`, `"ready"`, `"failed"` | yes |   |   |

## media.delete

Move a picture to the Trash. Published content that shows it stops showing it to the public; it can be restored for 30 days, after which the purge deletes the file.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## media.findByHash

Which of these files the media library has already, by the SHA-256 of their bytes (hex): the item for each one it has. An import asks this before uploading, so a re-run uploads nothing twice. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sha256` | array of string | yes | at least 1, at most 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `items[].name` | string | yes |   |   |
| `items[].type` | string | yes |   |   |
| `items[].bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].width` | integer or null | yes |   |   |
| `items[].height` | integer or null | yes |   |   |
| `items[].alt` | string or null | yes |   |   |
| `items[].state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `items[].stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `items[].duration` | number or null | yes |   | A video's length in seconds |
| `items[].createdAt` | string | yes |   |   |
| `items[].createdBy` | string or null | yes |   |   |
| `items[].sha256` | string | yes |   |   |

## media.get

One picture of the media library. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `name` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `alt` | string or null | yes |   |   |
| `state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `duration` | number or null | yes |   | A video's length in seconds |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |

## media.list

The media library, newest first: each picture's name, type, size, dimensions and alt text. Filter and sort on those; pass nextCursor back as cursor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   |   |
| `sort` | object |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].values` | map of any | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## media.play

A short-lived token to play one ready video, and where it plays (HLS, DASH, Stream's player), signed by the host: staff may play any; a customer or the public only a video that a published record they may read shows, in a part they may read (a lesson's video only for a holder of access to its course, a trailer for anyone). Anything else, and a made-up id, is not found. The token is for this video only, lives at most an hour, and never allows a download. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `record` | object |   |   | The record that shows it, to look only there |
| `record.object` | string | yes | max length 81 |   |
| `record.id` | string | yes | max length 64 |   |
| `field` | string |   | max length 40 | The field of that record that shows it |
| `purpose` | `"stream"` |   | default `"stream"` | stream: to watch. (A download for offline viewing is not offered yet.) |
| `seconds` | integer |   | ≥ 60, ≤ 3600 | How long the token lives; at most, and by default, an hour |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `token` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |
| `hls` | string | yes |   |   |
| `dash` | string | yes |   |   |
| `iframe` | string | yes |   |   |
| `poster` | string | yes |   | The poster frame Stream made, with the token |
| `duration` | number or null | yes |   |   |
| `captions` | array of object | yes |   |   |
| `captions[].language` | string | yes |   |   |
| `captions[].label` | string | yes |   |   |

## media.restore

Bring a picture back from the Trash (within 30 days of its deletion).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `name` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `alt` | string or null | yes |   |   |
| `state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `duration` | number or null | yes |   | A video's length in seconds |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |

## media.serve

Whether the caller may be served one picture or downloadable file, and at what width: staff any live one; a customer or the public only one that a published record they may read shows in a part they may read. Anything else is not found, and so is a video (it plays with media.play). The media route (`/api/media/<id>`) streams it. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `width` | integer |   | ≥ 1, ≤ 10000 | The width asked for |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `key` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   | The width to serve; null for the original |
| `public` | boolean | yes |   | Served because published content shows it |

## media.settings.get

Get the media library's settings: whether generated captions are on. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `generatedCaptions` | boolean | yes |   | Staff may ask Stream to generate captions (Stream charges for them) |

## media.settings.update

Turn generated captions on or off for the media library. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `generatedCaptions` | boolean | yes |   | Staff may ask Stream to generate captions (Stream charges for them) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `generatedCaptions` | boolean | yes |   | Staff may ask Stream to generate captions (Stream charges for them) |
| `previous` | object | yes |   |   |
| `previous.generatedCaptions` | boolean | yes |   | Staff may ask Stream to generate captions (Stream charges for them) |

## media.update

Change a picture's name or alt text. The picture itself never changes.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |
| `name` | string |   | min length 1, max length 200 |   |
| `alt` | string or null |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `name` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `alt` | string or null | yes |   |   |
| `state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `duration` | number or null | yes |   | A video's length in seconds |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |

## media.upload

Store a picture or a downloadable file a person uploaded in the media library: a picture is JPEG, PNG, GIF, WebP or AVIF, at most 10 MB; a file is a PDF, at most 50 MB; the type is read from the file, never its name. The file comes from the upload route, not from this input. A video is not uploaded here (media.videoUpload). Returns the item, which rich text, image fields and documents name by id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 | The file's name, for the library |
| `alt` | string |   | max length 500 | What the picture shows |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `name` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `alt` | string or null | yes |   |   |
| `state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `duration` | number or null | yes |   | A video's length in seconds |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `existing` | boolean | yes |   | The library had this file already: that item, not a new one |

## media.videoFromUrl

Add a video to the media library by Stream copying it from an address (https only): a file the old platform or a Vimeo or Wistia account serves. Stream fetches it; the item is `processing` until Stream says ready (media.videoRefresh). Every video needs a token to play. A person only: an import runs it (cos courses import).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 |   |
| `url` | string (uri) | yes | max length 2000 |   |
| `sha256` | string |   | pattern `^[0-9a-f]{64}$` | SHA-256 (hex) of the file's bytes, or of the address it is copied from |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `item` | object | yes |   |   |
| `item.id` | string | yes |   |   |
| `item.kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `item.name` | string | yes |   |   |
| `item.type` | string | yes |   |   |
| `item.bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `item.width` | integer or null | yes |   |   |
| `item.height` | integer or null | yes |   |   |
| `item.alt` | string or null | yes |   |   |
| `item.state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `item.stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `item.duration` | number or null | yes |   | A video's length in seconds |
| `item.createdAt` | string | yes |   |   |
| `item.createdBy` | string or null | yes |   |   |

## media.videoRefresh

Ask Cloudflare Stream how one video is (processing, ready or failed, its length and size) and keep the answer on the item, with its captions' states. If anything had made the video playable without a token, it is made to require one again.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A media item's id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `name` | string | yes |   |   |
| `type` | string | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `alt` | string or null | yes |   |   |
| `state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `duration` | number or null | yes |   | A video's length in seconds |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `captions` | array of object | yes |   |   |
| `captions[].language` | string | yes |   |   |
| `captions[].label` | string | yes |   |   |
| `captions[].generated` | boolean | yes |   |   |
| `captions[].state` | `"processing"`, `"ready"`, `"failed"` | yes |   |   |

## media.videoUpload

Ask for a one-time address to upload one video to the media library, held in Cloudflare Stream: the admin's browser sends the file there itself (resumable for a large file), never through this operation. The item is `uploading` until Stream has the file, then `processing`, and a record can show it only once it is `ready` (media.videoRefresh asks). Every video needs a token the host signs to play. A person only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 | The file's name, for the library |
| `bytes` | integer | yes | ≥ 1, ≤ 29999999999 | The file's size in bytes (under 30 GB): Stream takes no more than this |
| `sha256` | string |   | pattern `^[0-9a-f]{64}$` | SHA-256 (hex) of the file's bytes, or of the address it is copied from |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `item` | object | yes |   |   |
| `item.id` | string | yes |   |   |
| `item.kind` | `"image"`, `"video"`, `"file"` | yes |   | A picture, a video or a downloadable file |
| `item.name` | string | yes |   |   |
| `item.type` | string | yes |   |   |
| `item.bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `item.width` | integer or null | yes |   |   |
| `item.height` | integer or null | yes |   |   |
| `item.alt` | string or null | yes |   |   |
| `item.state` | `"uploading"`, `"processing"`, `"ready"`, `"failed"` or null | yes |   | A video: uploading, processing (Stream is encoding it), ready to play, or failed |
| `item.stateReason` | string or null | yes |   | A failed video: Stream's reason |
| `item.duration` | number or null | yes |   | A video's length in seconds |
| `item.createdAt` | string | yes |   |   |
| `item.createdBy` | string or null | yes |   |   |
| `upload` | object or null | yes |   | Where to send the file; null in a dry run |
| `upload.url` | string | yes |   |   |
| `upload.protocol` | `"tus"`, `"post"` | yes |   | tus: resumable PATCHes; post: one form post |
| `upload.chunkBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `upload.expiresAt` | string | yes |   |   |
