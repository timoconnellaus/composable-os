# Cloudflare Stream: the first run against a real account

Stage 42 (ADRs [0475](adr/0475-video-and-file-media-in-stream.md),
[0476](adr/0476-signed-playback.md)). The build was tested only against the fake Stream
(`packages/core/src/records/stream-fake.ts`). Nothing here has been run against a real account
yet. A person does every step; no credential is ever given to an agent or the assistant, put in
the database, or committed.

## 1. On the company's Cloudflare account (a person)
1. Turn on Stream (Dashboard → Stream). It is billed per minute stored and delivered; check the
   prices on <https://developers.cloudflare.com/stream/pricing/> before turning it on.
2. Note the **account id** and the **customer code**: the part `<code>` of
   `customer-<code>.cloudflarestream.com`, shown on any video's embed address in the dashboard.
3. Make an **API token** with the permission **Stream: Edit** on this account only, and nothing
   else (Dashboard → My Profile → API Tokens → Create Token → Custom).
4. Make a **signing key** with that token:
   ```
   curl -X POST -H "Authorization: Bearer <token>" \
     https://api.cloudflare.com/client/v4/accounts/<account id>/stream/keys
   ```
   Keep `result.id` and `result.jwk` (base64, shown once). Up to 1,000 keys may exist; deleting a
   key (`DELETE /stream/keys/<id>`) stops every token signed with it.

## 2. On the host's Worker (cos-app)
```
wrangler secret put STREAM_API_TOKEN        # the token from step 3
wrangler secret put STREAM_SIGNING_JWK      # result.jwk from step 4, as given (base64)
```
and set the vars (`wrangler.jsonc` of the deployment, or the dashboard):
`STREAM_ACCOUNT_ID`, `STREAM_CUSTOMER_CODE`, `STREAM_SIGNING_KEY_ID` (`result.id`). Leave
`STREAM_FAKE` empty. `STREAM_ALLOWED_ORIGINS` may stay empty: videos then play only from the
host's own hostname (`BETTER_AUTH_URL`), the company's web app (`CUSTOMER_AUTH_URL`) and
`API_ALLOWED_ORIGINS`. Until all five are set, the video operations answer "Video is not
configured here".

## 3. By hand, once (acceptance criterion 3's part only a real account can show)
1. In the admin, upload a short video in a `video` field's picker. Check in the Stream dashboard
   that the video exists with **Require signed URLs** on and **Allowed origins** as above.
2. Wait for it to be ready ("Check again"). A record can name it only then.
3. Call `media.play` for it as staff (the admin, or `/api/v1/op/media.play`). Open the `hls`
   address in Safari, or in a page with hls.js on an allowed origin: it plays.
4. Open `https://customer-<code>.cloudflarestream.com/<video uid>/manifest/video.m3u8` (the id in
   place of the token): it must be refused.
5. Change one character of the token's last part: refused. Ask for a token with `seconds: 60`,
   wait two minutes: refused.
6. Open `<token address>/downloads/default.mp4`: refused (no token the host signs allows a
   download).
7. Play the token from a page on a hostname not in the allowed origins: refused.
8. In the phone app, play a `hls` address with the native player. **Check whether Stream's
   allowed origins refuse a native player** (it sends no `Origin`). If they do, the phone's
   requests need the host's hostname as their referrer, or allowed origins must be left empty for
   the app's videos; that choice is an ADR 0475 amendment, not a setting changed by hand.
9. Delete the video in the admin, then purge it from the Trash (or wait for the purge): it is gone
   from the Stream dashboard after the next 10-minute cron.
10. Upload a WebVTT caption: it shows in the Stream dashboard and in the player's captions.

Record what happened, and any difference from what the fake does, in ADR 0475 as an amendment.

## What the fake does not show
- Stream's real encoding times and its error codes for broken files.
- Whether `allowedOrigins` in a tus upload's metadata is applied (the host sets it again on
  `media.videoRefresh` only when a video stopped requiring signed tokens; check step 1).
- CORS on Stream's upload addresses from the admin's origin (Stream documents the basic upload
  and tus endpoints as callable from a browser).
- Generated captions: their price and their languages.
