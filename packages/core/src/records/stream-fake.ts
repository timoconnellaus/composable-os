// A fake Cloudflare Stream (stage 42, ADR 0475), for tests and local development, as the fake
// payments provider is for payments. It behaves like the real one where the host depends on it:
//
// - a one-time direct upload address, taken as one form post (basic) or tus PATCHes (resumable),
//   refused once used, after it expires, or past the size it was made for;
// - a video is `uploading` until its file arrives, then `processing`, then `ready` (or `failed`),
//   as Stream encodes it; `requireSignedURLs` and `allowedOrigins` as it was made;
// - playing: the HLS manifest at `<base>/<token>/manifest/video.m3u8` is served only for a token
//   it verifies (RS256 with the signing key's public half, its `kid`, `sub` a ready video, `exp`
//   not passed, `nbf` reached); the video's id in place of a token is refused while the video
//   requires signed URLs; a download (`/downloads/default.mp4`) needs `downloadable: true`;
// - captions per language; deleting a video deletes it and its captions, and is idempotent;
// - a video's `creator`, as an upload or copy named it, in its details (stage 66 step 5).
//
// Its state is in memory, in the isolate that made it: a test makes its own, and `vite dev` keeps
// one for the dev server's life. Never configured in a deployment (STREAM_FAKE is for dev).
import { fromBase64url, toHex } from "../digest.ts";
import {
  BASIC_UPLOAD_MAX_BYTES,
  type StreamCaption,
  type StreamPlayback,
  type StreamProvider,
  type StreamSigner,
  type StreamVideoDetails,
  streamSigner,
  TUS_CHUNK_BYTES,
  type VideoHost,
} from "./stream.ts";

interface FakeVideo {
  uid: string;
  name: string;
  state: StreamVideoDetails["state"];
  reason: string | null;
  expected: number;
  received: number;
  protocol: "tus" | "post" | "copy";
  uploadExpiresAt: number;
  requireSignedURLs: boolean;
  allowedOrigins: string[];
  duration: number | null;
  captions: Map<string, StreamCaption>;
  creator: string | null;
}

/** What a test or the dev server can do to the fake beside what the host does. */
export interface FakeStreamControl {
  /** Serves the fake's addresses (uploads and playback) under its base URL. */
  handle(request: Request): Promise<Response>;
  /** Finish encoding: the video is ready (or failed, with a reason). */
  finish(uid: string, outcome?: "ready" | { failed: string }): void;
  /** A video as the fake holds it (undefined once deleted). */
  video(uid: string): Readonly<FakeVideo> | undefined;
  /** Every call the host made, in order, for tests to read. */
  readonly calls: { method: string; uid?: string; detail?: unknown }[];
}

export interface FakeStreamOptions {
  /** The base its addresses are served under, e.g. http://localhost:5173/api/v1/media/fake-stream. */
  baseUrl: string;
  /** Ready as soon as the file has arrived, at the next `details` (dev); false: wait for finish(). */
  autoReady?: boolean;
  now?: () => number;
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEY_ID = "fake-stream-signing-key";

/** A fake Stream, its signer and its controls. */
export function createFakeStream(options: FakeStreamOptions): VideoHost & {
  fake: FakeStreamControl;
} {
  const base = options.baseUrl.replace(/\/+$/, "");
  const now = options.now ?? (() => Date.now());
  const videos = new Map<string, FakeVideo>();
  const calls: FakeStreamControl["calls"] = [];
  let keys: Promise<CryptoKeyPair> | undefined;
  const keyPair = () => {
    keys ??= crypto.subtle.generateKey(
      { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
    return keys;
  };
  const newUid = () => {
    return toHex(crypto.getRandomValues(new Uint8Array(16)));
  };
  const live = (uid: string) => videos.get(uid);
  const notFound = () => new Response("Not found", { status: 404 });

  const provider: StreamProvider = {
    name: "fake",
    async createUpload(input) {
      const uid = newUid();
      const protocol = input.bytes <= BASIC_UPLOAD_MAX_BYTES ? "post" : "tus";
      calls.push({ method: "createUpload", uid, detail: { ...input } });
      videos.set(uid, {
        uid,
        name: input.name,
        state: "uploading",
        reason: null,
        expected: input.bytes,
        received: 0,
        protocol,
        uploadExpiresAt: Date.parse(input.expiresAt),
        requireSignedURLs: true,
        allowedOrigins: [...input.allowedOrigins],
        duration: null,
        captions: new Map(),
        creator: input.creator ?? null,
      });
      return {
        uid,
        url: `${base}/upload/${uid}`,
        protocol,
        chunkBytes: protocol === "tus" ? TUS_CHUNK_BYTES : input.bytes,
      };
    },
    async copyFromUrl(input) {
      const uid = newUid();
      calls.push({ method: "copyFromUrl", uid, detail: { ...input } });
      videos.set(uid, {
        uid,
        name: input.name,
        state: "processing",
        reason: null,
        expected: 0,
        received: 0,
        protocol: "copy",
        uploadExpiresAt: 0,
        requireSignedURLs: true,
        allowedOrigins: [...input.allowedOrigins],
        duration: null,
        captions: new Map(),
        creator: input.creator ?? null,
      });
      return { uid };
    },
    async details(uid) {
      calls.push({ method: "details", uid });
      const video = live(uid);
      if (!video) return null;
      if (video.state === "processing" && options.autoReady !== false) finish(uid, "ready");
      return {
        uid,
        state: video.state,
        reason: video.reason,
        duration: video.duration,
        width: video.state === "ready" ? 1920 : null,
        height: video.state === "ready" ? 1080 : null,
        requireSignedURLs: video.requireSignedURLs,
        creator: video.creator,
      };
    },
    async secure(uid, allowedOrigins) {
      calls.push({ method: "secure", uid, detail: [...allowedOrigins] });
      const video = live(uid);
      if (!video) throw new Error("Stream has no such video");
      video.requireSignedURLs = true;
      video.allowedOrigins = [...allowedOrigins];
    },
    async delete(uid) {
      calls.push({ method: "delete", uid });
      videos.delete(uid);
    },
    async uploadCaption(uid, language, vtt) {
      calls.push({ method: "uploadCaption", uid, detail: { language, bytes: vtt.byteLength } });
      const video = live(uid);
      if (!video) throw new Error("Stream has no such video");
      const text = new TextDecoder().decode(vtt.slice(0, 16));
      if (!text.replace(/^﻿/, "").startsWith("WEBVTT")) throw new Error("Not WebVTT");
      video.captions.set(language, { language, label: language, generated: false, state: "ready" });
    },
    async generateCaption(uid, language) {
      calls.push({ method: "generateCaption", uid, detail: { language } });
      const video = live(uid);
      if (!video) throw new Error("Stream has no such video");
      const caption: StreamCaption = {
        language,
        label: language,
        generated: true,
        state: "processing",
      };
      video.captions.set(language, caption);
      return caption;
    },
    async deleteCaption(uid, language) {
      calls.push({ method: "deleteCaption", uid, detail: { language } });
      live(uid)?.captions.delete(language);
    },
    async listCaptions(uid) {
      calls.push({ method: "listCaptions", uid });
      return [...(live(uid)?.captions.values() ?? [])];
    },
  };

  // The host's own signer (stream.ts), with a key the fake made: what Stream would verify.
  let real: StreamSigner | undefined;
  const signer: StreamSigner = {
    async sign(input) {
      if (!real) {
        const jwk = await crypto.subtle.exportKey("jwk", (await keyPair()).privateKey);
        real = streamSigner(KEY_ID, jwk as JsonWebKey);
      }
      return real.sign(input);
    },
  };

  function finish(uid: string, outcome: "ready" | { failed: string } = "ready") {
    const video = live(uid);
    if (!video) return;
    if (outcome === "ready") {
      video.state = "ready";
      video.duration = 61.5;
    } else {
      video.state = "failed";
      video.reason = outcome.failed;
    }
  }

  /** The claims of a token the fake verifies, or why it is refused. */
  async function verify(token: string): Promise<Record<string, unknown> | string> {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return "not a token";
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
      claims = JSON.parse(new TextDecoder().decode(fromBase64url(p)));
    } catch {
      return "not a token";
    }
    if (header.alg !== "RS256" || header.kid !== KEY_ID || claims.kid !== KEY_ID) return "key";
    const ok = await crypto.subtle.verify(
      RS256,
      (await keyPair()).publicKey,
      fromBase64url(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return "signature";
    const seconds = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return "expired";
    if (typeof claims.nbf === "number" && claims.nbf > seconds) return "not yet";
    return claims;
  }

  async function play(idOrToken: string, rest: string): Promise<Response> {
    const plain = live(idOrToken);
    let uid: string;
    let claims: Record<string, unknown> = {};
    if (plain) {
      // The id in place of a token: refused while the video requires signed URLs.
      if (plain.requireSignedURLs) return new Response("Signed URL required", { status: 401 });
      uid = plain.uid;
    } else {
      const verified = await verify(idOrToken);
      if (typeof verified === "string") return new Response(verified, { status: 401 });
      claims = verified;
      uid = String(claims.sub ?? "");
    }
    const video = live(uid);
    if (!video || video.state !== "ready") return notFound();
    if (rest.startsWith("downloads/")) {
      return claims.downloadable === true
        ? new Response("fake mp4", { headers: { "content-type": "video/mp4" } })
        : new Response("Downloads are not allowed", { status: 401 });
    }
    if (rest === "manifest/video.m3u8") {
      return new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n", {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return notFound();
  }

  async function upload(request: Request, uid: string): Promise<Response> {
    const video = live(uid);
    if (!video || video.state !== "uploading") return notFound();
    if (now() > video.uploadExpiresAt)
      return new Response("Upload address expired", { status: 410 });
    const tusHeaders = { "Tus-Resumable": "1.0.0", "Upload-Offset": String(video.received) };
    if (video.protocol === "tus") {
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { ...tusHeaders, "Upload-Length": String(video.expected) },
        });
      }
      if (request.method !== "PATCH") return new Response("Use PATCH", { status: 405 });
      const offset = Number(request.headers.get("upload-offset") ?? "-1");
      if (offset !== video.received)
        return new Response("Offset mismatch", { status: 409, headers: tusHeaders });
      const chunk = new Uint8Array(await request.arrayBuffer());
      if (video.received + chunk.byteLength > video.expected) {
        return new Response("Larger than declared", { status: 413 });
      }
      video.received += chunk.byteLength;
      if (video.received === video.expected) video.state = "processing";
      return new Response(null, {
        status: 204,
        headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(video.received) },
      });
    }
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return new Response("No file", { status: 400 });
    const size = (file as Blob).size;
    if (size === 0 || size > video.expected) return new Response("Wrong size", { status: 413 });
    video.received = size;
    video.state = "processing";
    return new Response(null, { status: 200 });
  }

  const fake: FakeStreamControl = {
    calls,
    finish,
    video: (uid) => live(uid),
    async handle(request) {
      const path = new URL(request.url).pathname;
      const prefix = new URL(base).pathname.replace(/\/+$/, "");
      if (!path.startsWith(`${prefix}/`)) return notFound();
      const parts = path.slice(prefix.length + 1).split("/");
      if (parts[0] === "upload" && parts[1]) return upload(request, parts[1]);
      if (request.method !== "GET" && request.method !== "HEAD") return notFound();
      const first = decodeURIComponent(parts[0] ?? "");
      return play(first, parts.slice(1).join("/"));
    },
  };

  const playback = (token: string): StreamPlayback => {
    const at = `${base}/${encodeURIComponent(token)}`;
    return {
      hls: `${at}/manifest/video.m3u8`,
      dash: `${at}/manifest/video.mpd`,
      iframe: `${at}/iframe`,
      thumbnail: `${at}/thumbnails/thumbnail.jpg`,
    };
  };

  return { provider, signer, playback, allowedOrigins: [new URL(base).hostname], fake };
}
