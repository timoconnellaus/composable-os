# ADR 0476: Signed playback is a host rule

Status: accepted, 2026-11-22 (stage 42, build step 2). Builds on ADRs
[0444](0444-media-the-editor-and-the-content-pack.md) (`media.serve`, as amended for issue #181),
[0475](0475-video-and-file-media-in-stream.md) (videos in Stream) and
[0477](0477-the-access-scope.md) (holders).

## Context
Every video requires a signed token (ADR 0475). Who gets one is a rule, and rules live in the
host (ADR 0401): a block, a hook or a client app is given an address and a token and never builds
either. The spec (section 2) asks for `media.play { id, record, field }` following the rule
`media.serve` follows for pictures, a token that expires (an hour by default), staff getting any
ready video, a public trailer playing for anyone, the one not-found for everything else, and a
`purpose` with one value so a download for offline viewing can be added later.

## Decision
- **`media.play`** (`operations/media-video.ts`): audiences staff, customer and public; risk
  `read`; `records:read`; `hostInternal` (it reads `core_published_media`, as `media.serve` does);
  not on MCP. Input `{ id, record?: { object, id }, field?, purpose: "stream", seconds? }`.
- **Who may play** is one function with `media.serve`, `outsiderShown` (`operations/media.ts`):
  staff any **ready** video; a customer or the public only a ready video that the current
  version of a record they may read shows, in a field their scope reads, in a part of that field
  they read. A part is read by everyone who reads the field (`reach = all`), only by a holder of
  access to the record (`holders`, ADR 0477), or by no outsider (`private`): `core_published_media`
  keeps the reach of each item a version shows, written with the version
  (`documentMediaReach`, read from `redactDocument` itself, so the rule and the redaction are one
  code). `record` and `field` narrow the search to that record or field; they never widen it.
- **The one not-found.** A made-up id, a picture, a video still processing or failed, a draft's,
  an unpublished record's, a staff-only field's, a private part's and a holders' part's for a
  non-holder all answer exactly `{ code: "not_found", message: "Not found", details: { object:
  "media" } }`. Nothing says the video exists.
- **The token** is made by the host, never by Stream's token API: RS256 with the deployment's
  Stream signing key (`streamSigner`, `records/stream.ts`), header `{ alg, kid }`, claims
  `{ sub: <the video's Stream id>, kid, exp }`. `sub` binds it to one video; `exp` is at most an
  hour from now (`PLAYBACK_MAX_SECONDS`; `seconds` may ask for less, never more; Stream allows 24
  hours); there is no `downloadable` claim, so no token allows a download. Playing costs no call
  to Stream.
- **The answer**: the token, when it expires, and where it plays on the account's playback
  subdomain with the token in place of the id (HLS, DASH, Stream's iframe player, the poster
  frame), the duration and the ready caption tracks. A hook asks again before `expiresAt`
  (step 7's `usePlayback`).
- **No token is audited.** A customer's or the public's call that is audited keeps its result with
  `token`, `hls`, `dash`, `iframe` and `poster` redacted (`redactResult`, ADR 0475).
- **Offline is designed in, not built.** `purpose` has one value, `stream`. A later `download`
  purpose would sign `downloadable: true` under the same rule; none is issued now.
- **Phones ask the host itself** over the HTTP surface (`POST /api/v1/op/media.play`), and a
  company's web app over its binding: both are `invoke()`, so the rule is the same.

## Proof
`packages/core/test/video.test.ts`: staff's token plays (the fake verifies it as Stream does), is
for that video only (`sub`; a token edited to name another video does not verify), expires
within the hour and stops at its expiry, has no `downloadable` claim, and the video's id in place
of a token does not play, nor does a download; no token over an hour is given. A published
trailer plays for the public; a draft's, a staff-only field's and a made-up id are the one
not-found; a picture is not played and a video is not served; unpublished, it stops; a video
processing or failed is not played even by staff. `packages/core/test/access.test.ts` and the
isolation suite (ADR 0477) for holders. Each check removed, tests fail: see ADR 0477's list.

**Not run:** a token against real Stream (the runbook, `docs/stream-runbook.md`, step 3).

## Consequences
- `media.play` is opened to `customer` and `public`; it is in `open-operations.json` and the API
  contract. It reads only what `media.serve` reads, and refuses alike.
- A token leaked from a page source works for at most an hour and for one video.
