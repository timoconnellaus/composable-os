# ADR 0475: Video and file media, held in Cloudflare Stream

Status: accepted, 2026-11-22 (stage 42, build step 1). Builds on ADR
[0444](0444-media-the-editor-and-the-content-pack.md) (the media library) and its amendments,
[0445](0445-the-document-field.md) (the document field) and [0320](0320-erase-reaches-every-store.md)
(the blob deletion path). Signed playback is [ADR 0476](0476-signed-playback.md); who holds access
to a course's lessons is [ADR 0477](0477-the-access-scope.md).

## Context
Stage 42 sells video courses. The media library held pictures only. The spec
([`docs/stages/42-courses.md`](../stages/42-courses.md), "Scope: what the platform needs first",
1) asks for videos in Cloudflare Stream on the company's own account, uploaded straight from the
staff browser, with signed playback required for every video, captions, a `video` field, and a
`file` kind (PDF) for downloads. Stream is an outside service; the spec left open whether the
Workers binding covers it or an API token is a host secret.

## Decision

### Kinds of media item (migration 0510)
- `core_media` gains `kind`: `image` (as before), `file` and `video`. SQLite cannot change a CHECK,
  so the table is rebuilt with its rows, indexes and Trash trigger. One CHECK holds the shape of
  each kind: a picture or a file has an R2 `key` and no Stream id; a video has a `stream_uid`, a
  `state` and no key.
- **A file** is a PDF only (its first bytes are `%PDF-`, never its name or a client's word), at
  most 50 MB, uploaded and stored exactly as a picture is (`POST /api/media`, `media.upload`, R2
  under `media/`), served by `media.serve`'s rule, with `content-disposition: attachment`.
- **A video** is held in Stream. The row keeps Stream's id, its state (`uploading`,
  `processing`, `ready`, `failed`, and Stream's reason code when it failed), its duration and
  dimensions. Its `type` is `video/stream`. Nothing of it is in R2.
- `core_media_caption`: one caption track per video and language (BCP 47), its label, whether
  Stream generated it, and its state.

### Upload goes straight to Stream
- `media.videoUpload { name, bytes }` (a person only: `actors: ["human"]`, not on MCP, so no MCP
  client, assistant, automation or extension can ask; risk `write`) asks Stream for a one-time
  direct upload address and makes the row `uploading`. Up to 200 MB it is Stream's basic direct
  upload (one form post of the file); above, a resumable tus upload (`?direct_user=true`, chunks
  of 50 MiB, a multiple of 256 KiB). The admin's browser sends the file there
  (`apps/app/src/components/fields/video-picker.tsx`); the file never passes through an
  operation's input or a Worker body. The address expires after 6 hours and is never kept: the
  audit row's result has it redacted (`redactResult`, a new operation option, below).
- Every upload asks for `requireSignedURLs: true` and the deployment's allowed origins (the host's
  hostname and the company's web apps': `BETTER_AUTH_URL`, `CUSTOMER_AUTH_URL`,
  `API_ALLOWED_ORIGINS`, or `STREAM_ALLOWED_ORIGINS`), and a longest duration of 6 hours.
- `media.videoRefresh { id }` asks Stream for the video's state and keeps it on the row, with the
  states of captions being generated. If Stream says the video no longer requires a signed token
  (someone changed it in Stream's dashboard), it sets it back. There is no setting anywhere in
  the host that makes a video public.
- **Only a ready video may be named.** A document `ref` to `media` may now say which kind it takes
  (`media: "image" | "video" | "file"`); the host checks it on every write
  (`assertMediaKinds`, `operations/record.ts`), and for a video that it is `ready`. The rich text
  picture and the `image` field take `media: "image"`, so a video or a PDF is never a picture.
- **The `video` field type** is `{ media, poster? }` (`VIDEO_SCHEMA`): a video and, optionally, a
  picture to show before it plays. `VIDEO_NODE` and `FILE_NODE` (the SDK) are the same shapes for a
  pack's own document (a lesson in a course's outline, step 4).
- Stream's upload by link (`copyFromUrl`) is in the provider for the import (step 8); no
  operation uses it yet.
- Stream's webhook is not used yet: the admin asks (`media.videoRefresh`, and the picker's "Check
  again"). A later change may add the webhook (`PUT /stream/webhook`, `Webhook-Signature:
  time=…,sig1=…`, HMAC-SHA256 of `time.body`) and a cron; nothing here depends on it.

### Captions
- `POST /api/media/<id>/captions?language=&label=` (cos-app, staff, the host's own origin; not on
  the client-app binding) hands a WebVTT file to `media.captionUpload` as `ctx.upload`; it must
  start with `WEBVTT` and be at most 10 MB (Stream's limit). An `.srt` is the import's to convert.
- `media.captionGenerate` asks Stream to generate a track; it is refused until a human admin turns
  generated captions on (`media.settings.update`, `settings:manage`, a person only), because
  their price is not published. `media.captionDelete` removes one. `media.play` gives the player
  the ready tracks.

### Purge
The Trash purge deletes the row; the rebuilt trigger queues `stream/<uid>` on
`core_blob_deletion` in the same batch, and the drain (`drainBlobDeletions`) deletes it from
Stream, retrying on the 10-minute cron as for R2. Where Stream is not configured those keys wait
and hold up nothing else. A purged video's captions go with its row.

### Reaching Stream: the host's own REST calls, not a gatekeeper and not the binding
- **Not a gatekeeper.** A gatekeeper (ADR 0012) is how *extension code* and the assistant reach an
  outside service, with actions an approval can hold. Nothing here is reachable by them: the
  media operations are core operations, a person's where they upload, and the video host is set
  once per isolate from the Worker's env (`setVideoHost`, `records/stream.ts`), never from an
  operation's input or the database. It is the media library's storage, as R2 (`BLOBS`) and
  Cloudflare Images (`IMAGES`) are, both bound to cos-app directly. Playing must not cost a call
  to anything: the token is signed in the host (ADR 0476), which a gatekeeper round trip would
  only slow. "External access goes only through gatekeepers" is about extension code, which keeps
  `globalOutbound: null` and has no way to these calls.
- **Not the Workers binding.** The binding (`env.STREAM`, 2026-05) has `createDirectUpload`, but
  only Stream's basic upload: no tus, so no file over 200 MB, and a lesson's video is often more.
  Its `video(id).generateToken()` takes no expiry or claims, so the host could not hold a token to
  an hour or state that it allows no download, and each token would be a call. So the host uses
  Stream's REST API with an account API token (**Stream: Edit** only), and signs tokens itself
  with a Stream signing key.
- **Credentials are env only.** `STREAM_API_TOKEN` and `STREAM_SIGNING_JWK` are cos-app's
  secrets (listed in `apps/app/deploy-inputs.json`, `required: false`); `STREAM_ACCOUNT_ID`,
  `STREAM_CUSTOMER_CODE` and `STREAM_SIGNING_KEY_ID` its vars. A person sets them
  ([`docs/stream-runbook.md`](../stream-runbook.md)). No operation reads, sets or returns them;
  the assistant cannot configure them. Until all five are set, every video operation answers
  `config` ("Video is not configured here").
- **A fake Stream** (`records/stream-fake.ts`), as the fake payments provider is for payments,
  behaves like the real one where the host depends on it: one-time basic and tus upload addresses
  (refused once used, expired, at the wrong offset), `uploading` → `processing` → `ready` or
  `failed`, `requireSignedURLs`, caption tracks, deletion, and playback that verifies the token
  (RS256 with the key's public half, `kid`, `sub` a ready video, `exp`, `nbf`), refuses the id in
  place of a token, and refuses a download without `downloadable`. Its signer is the host's own
  (`streamSigner`). Local development turns it on with `STREAM_FAKE=true` in `.dev.vars`; it
  serves its addresses at `/api/v1/media/fake-stream/*` only then.

### `redactResult`
An operation may name keys of its result to redact in its audit row (`redactResult`; secret-looking
keys of that result are redacted with them). `media.videoUpload` redacts the address;
`media.play` the token and every address that carries it. Inputs were redacted already
(`redact`); results were not, and a token in an audit row would be readable by staff for its
hour.

## Sources (read 2026-11-22)
- Securing videos: `requireSignedURLs`, self-signed tokens (RS256, `kid`, `sub`, `exp`, `nbf`,
  `downloadable`, `accessRules`, at most 24 hours), `POST /stream/keys` (`id`, `pem`, `jwk`,
  base64, shown once), `POST /stream/{uid}/token`, `allowedOrigins`, the token in place of the id
  in `customer-<code>.cloudflarestream.com/<token>/manifest/video.m3u8`:
  <https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/>.
- The Workers binding (`createDirectUpload` basic only, no tus; `video(id).generateToken()` with
  no parameters; `captions.upload/generate/list/delete`):
  <https://developers.cloudflare.com/stream/manage-video-library/bindings/> and the changelog
  <https://developers.cloudflare.com/changelog/post/2026-05-07-stream-workers-binding/>.
- Direct creator uploads (`POST /stream/direct_upload` with `maxDurationSeconds`, `uploadURL` and
  `uid`; tus at `POST /stream?direct_user=true`, `Location`; basic under 200 MB):
  <https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/>.
- Resumable uploads (`stream-media-id` header for the id; metadata `name`, `requiresignedurls`,
  `allowedorigins`; chunks at least 5,242,880 bytes, at most 209,715,200, divisible by 256 KiB):
  <https://developers.cloudflare.com/stream/uploading-videos/resumable-uploads/>.
- Upload by link (`POST /stream/copy` with `url`, `meta`):
  <https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/>.
- Video details (`status.state`: `pendingupload`, `downloading`, `queued`, `inprogress`, `ready`,
  `error`, `live-inprogress`; `errorReasonCode`; `duration`, `input.width/height`, `-1` unknown):
  <https://developers.cloudflare.com/api/resources/stream/methods/get/>; delete
  (`DELETE /stream/{identifier}`, Stream Write): <https://developers.cloudflare.com/api/resources/stream/methods/delete/>.
- Captions (`PUT /stream/{uid}/captions/{language}` multipart `file`, `…/generate`, list, delete;
  WebVTT only, 10 MB; `inprogress`, `ready`, `error`):
  <https://developers.cloudflare.com/stream/edit-videos/adding-captions/>.
- Webhooks (`PUT /stream/webhook`, `Webhook-Signature`), not used yet:
  <https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/>.
- Pricing ($5 a month per 1,000 minutes stored, $1 per 1,000 minutes delivered; generated
  captions not priced there): <https://developers.cloudflare.com/stream/pricing/>.

## Proof
- `packages/core/test/video.test.ts`, against the fake: an upload asks Stream for a video that
  requires a signed token, from the deployment's origins, and the audit row has no address; the
  address is one-time; the item is `processing` until Stream says `ready`; a large file is a tus
  upload taken at the right offsets; a record naming a video not ready, a picture where a video
  goes, or a made-up id is refused; an MCP client, the assistant, an automation and the public
  cannot ask for an upload; captions are WebVTT only, the client-app binding takes none, and
  generated ones are refused until a person turns them on; a PDF is a file, served as an
  attachment, refused over 50 MB; a failed video says Stream's reason; a video loosened in Stream
  is made to need a token again; purging a video deletes it from Stream; the real provider's
  requests (`direct_upload` with `requireSignedURLs`, tus with `requiresignedurls`) and its RS256
  token verify with the key's public half.
- `packages/core/test/media.test.ts` (ADR 0444's) passes with a PDF now taken as a file, not a
  picture.
- **Not run:** anything against a real Stream account. The runbook is the first run.

## Consequences
- The release carries two more optional cos-app secrets; a deployment that sets none has no
  video and nothing else changes.
- A purged video's Stream copy is deleted by the cron where the post-commit drain missed it, as an
  R2 object is.
- cos-runner does not hold the video host yet: a pack tool that runs there (step 4's `lesson`)
  calls `media.play` through the host, or the runner is given the same vars and secrets then.
- Whether Stream's `allowedOrigins` refuses a phone's native player (no `Origin`) is checked by
  hand in the runbook before the app plays videos.
