// The media library, to pick a picture or upload one (stage 28, ADR 0444): for a rich text
// picture and an `image` field. An upload goes to the media route (`POST /api/media`), which hands
// the file to `media.upload`: the host reads its type from its bytes and refuses what is not a
// picture it takes, or is too large.
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
import { invalidateOps, useOp } from "#/lib/query";

export interface PickedMedia {
  id: string;
  alt: string | null;
  name: string;
}

/** Uploads one file to the media library; the host's answer, or its refusal as an error. */
export async function uploadMedia(file: File, alt: string): Promise<PickedMedia> {
  const query = new URLSearchParams({ name: file.name || "picture", ...(alt ? { alt } : {}) });
  const response = await fetch(`/api/media?${query}`, { method: "POST", body: file });
  const body = (await response.json()) as {
    data?: PickedMedia;
    error?: { message?: string };
  };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "The upload failed");
  return body.data;
}

export function MediaPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (media: PickedMedia) => void;
}) {
  const client = useQueryClient();
  const library = useOp("media.list", { limit: 60 }, { enabled: open });
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const media = await uploadMedia(file, alt);
      await invalidateOps(client, "media.");
      onPick(media);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pictures</DialogTitle>
          <DialogDescription>
            Pick one from the library, or upload a JPEG, PNG, GIF, WebP or AVIF (at most 10 MB).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="media-alt">What the picture shows (alt text)</Label>
          <Input id="media-alt" value={alt} onChange={(e) => setAlt(e.target.value)} />
          <Label htmlFor="media-file">Upload</Label>
          <Input
            id="media-file"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
            disabled={busy}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
        <ul className="grid max-h-80 grid-cols-3 gap-2 overflow-auto" aria-label="Library">
          {(library.data?.items ?? []).map((item) => {
            const v = item.values as { name?: string; alt?: string | null };
            return (
              <li key={item.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full flex-col p-1"
                  onClick={() => onPick({ id: item.id, alt: v.alt ?? null, name: v.name ?? "" })}
                >
                  <img
                    src={`/api/media/${encodeURIComponent(item.id)}?w=320`}
                    alt={v.alt ?? ""}
                    className="aspect-square w-full rounded object-cover"
                  />
                  <span className="w-full truncate text-xs">{v.name}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** An `image` field's editor: a picture from the library, its alt text and focal point. */
export function ImageFieldEditor({
  value,
  onChange,
  id,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const picture = value as { media: string; alt: string; focal?: { x: number; y: number } } | null;
  const [picking, setPicking] = useState(false);
  return (
    <div className="grid gap-2" data-testid="image-field">
      {picture?.media ? (
        <img
          src={`/api/media/${encodeURIComponent(picture.media)}?w=320`}
          alt={picture.alt}
          className="max-h-40 w-fit rounded"
        />
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" id={id} onClick={() => setPicking(true)}>
          {picture?.media ? "Change picture" : "Choose a picture"}
        </Button>
        {picture?.media ? (
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
      </div>
      {picture?.media ? (
        <Input
          aria-label="Alt text"
          value={picture.alt}
          onChange={(e) => onChange({ ...picture, alt: e.target.value })}
        />
      ) : null}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(media) => {
          onChange({ media: media.id, alt: media.alt ?? picture?.alt ?? "" });
          setPicking(false);
        }}
      />
    </div>
  );
}
