// Videos of the media library (stage 42, ADR 0475): for a `video` field. An upload asks the host
// for a one-time direct upload address (`media.videoUpload`) and sends the file straight to
// Cloudflare Stream: one form post for a small file, resumable tus chunks for a large one. The
// file never passes through an operation or a Worker. The video can be picked once Stream has it
// ready (`media.videoRefresh` asks); the host refuses a record that names one that is not.
import { Button } from "@composable-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@composable-os/ui/components/dialog";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { invalidateOps, useOp } from "#/lib/query";

interface Upload {
  url: string;
  protocol: "tus" | "post";
  chunkBytes: number;
}

/** Sends `file` to the address Stream gave, reporting the share sent so far (0 to 1). */
export async function sendToStream(
  file: Blob,
  upload: Upload,
  progress: (share: number) => void = () => {},
): Promise<void> {
  if (upload.protocol === "post") {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(upload.url, { method: "POST", body: form });
    if (!response.ok) throw new Error(`The upload failed (${response.status})`);
    progress(1);
    return;
  }
  // tus 1.0.0: PATCH chunks at the offset the server last took; a dropped chunk is sent again.
  let offset = 0;
  let retries = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + upload.chunkBytes, file.size));
    const response = await fetch(upload.url, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: chunk,
    }).catch(() => null);
    if (!response || !response.ok) {
      if (retries++ >= 3) throw new Error("The upload stopped; try again");
      const head = await fetch(upload.url, {
        method: "HEAD",
        headers: { "Tus-Resumable": "1.0.0" },
      }).catch(() => null);
      offset = Number(head?.headers.get("upload-offset") ?? offset);
      continue;
    }
    retries = 0;
    offset = Number(response.headers.get("upload-offset") ?? offset + chunk.size);
    progress(offset / file.size);
  }
}

export interface PickedVideo {
  id: string;
  name: string;
}

export function VideoPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (video: PickedVideo) => void;
}) {
  const client = useQueryClient();
  const library = useOp(
    "media.list",
    { limit: 60, filter: { field: "kind", op: "eq", value: "video" } },
    { enabled: open },
  );
  const [sent, setSent] = useState<number | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setSent(0);
    try {
      const asked = await callOp("media.videoUpload", {
        name: file.name || "video",
        bytes: file.size,
      });
      if (!asked.upload) throw new Error("No upload address");
      await sendToStream(file, asked.upload, setSent);
      await callOp("media.videoRefresh", { id: asked.item.id });
      await invalidateOps(client, "media.");
      toast.success("Uploaded: Stream is preparing it. It can be picked once it is ready.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The upload failed");
    } finally {
      setSent(null);
    }
  }

  async function refresh(id: string) {
    await callOp("media.videoRefresh", { id });
    await invalidateOps(client, "media.");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Videos</DialogTitle>
          <DialogDescription>
            Pick a ready video, or upload one: it goes straight to Cloudflare Stream, and plays only
            for someone the host gives a token to.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="video-file">Upload</Label>
          <Input
            id="video-file"
            type="file"
            accept="video/*"
            disabled={sent !== null}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {sent !== null ? (
            <p className="text-sm text-muted-foreground">Sending… {Math.round(sent * 100)}%</p>
          ) : null}
        </div>
        <ul className="grid max-h-80 gap-1 overflow-auto" aria-label="Videos">
          {(library.data?.items ?? []).map((item) => {
            const v = item.values as { name?: string; state?: string; duration?: number | null };
            const ready = v.state === "ready";
            return (
              <li key={item.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">
                  {v.name} · {v.state}
                  {v.duration ? ` · ${Math.round(v.duration)} s` : ""}
                </span>
                {ready ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onPick({ id: item.id, name: v.name ?? "" })}
                  >
                    Pick
                  </Button>
                ) : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => refresh(item.id)}>
                    Check again
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** A `video` field's editor: a ready video from the library. */
export function VideoFieldEditor({
  value,
  onChange,
  id,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const video = value as { media: string; poster?: string } | null;
  const [picking, setPicking] = useState(false);
  const item = useOp("media.get", { id: video?.media ?? "" }, { enabled: Boolean(video?.media) });
  return (
    <div className="grid gap-2" data-testid="video-field">
      {video?.media ? (
        <p className="text-sm">
          {item.data?.name ?? video.media}
          {item.data?.state ? ` · ${item.data.state}` : ""}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" id={id} onClick={() => setPicking(true)}>
          {video?.media ? "Change video" : "Choose a video"}
        </Button>
        {video?.media ? (
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
      </div>
      <VideoPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(picked) => {
          onChange({ media: picked.id, ...(video?.poster ? { poster: video.poster } : {}) });
          setPicking(false);
        }}
      />
    </div>
  );
}
