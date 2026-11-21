// The media library's storage in cos-app (stage 28, ADR 0444): originals in the R2 bucket the
// host already binds (`BLOBS`, under `media/`), and Cloudflare Images for the sizes a client asks
// for, when the deployment binds it as `IMAGES`. Without `IMAGES` the original is served.
import type { MediaResizer, MediaStore } from "@composable-os/core";

/** The part of Cloudflare's Images binding this uses. */
interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(options: { width: number }): {
      output(options: { format: string }): Promise<{ response(): Response }>;
    };
  };
}

export interface MediaEnv {
  BLOBS?: R2Bucket;
  /** Cloudflare Images (optional): `"images": { "binding": "IMAGES" }` in wrangler.jsonc. */
  IMAGES?: ImagesBinding;
}

export function mediaStoreFor(env: MediaEnv): MediaStore | undefined {
  const bucket = env.BLOBS;
  if (!bucket) return undefined;
  return {
    put: async (key, bytes, type) => {
      await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
    },
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? { body: object.body, size: object.size } : null;
    },
    delete: async (keys) => {
      if (keys.length) await bucket.delete(keys);
    },
  };
}

/** Pictures smaller than their original, from Cloudflare Images; the original's type kept. */
export function mediaResizerFor(env: MediaEnv): MediaResizer | undefined {
  const images = env.IMAGES;
  if (!images) return undefined;
  return {
    async resize(body, { width, type }) {
      const result = await images.input(body).transform({ width }).output({ format: type });
      const response = result.response();
      if (!response.body) throw new Error("Cloudflare Images returned no picture");
      return { body: response.body, type: response.headers.get("content-type") ?? type };
    },
  };
}
