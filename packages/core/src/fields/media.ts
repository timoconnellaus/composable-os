// Field registry for Media (stage 28, ADR 0444): the media library, a base record in core. A
// rich text picture and an `image` field name one by id; the host checks the id is a live item.
// No customer or public declaration: outsiders read no media record. A picture reaches them only
// through `media.serve`, for an item published content references.

// Stage 42 (ADR 0475): a video (held in Cloudflare Stream, played only through `media.play`) and
// a downloadable file (a PDF, in R2, served as a picture is) are media items too.
import {
  MEDIA_FILE_TYPES,
  MEDIA_KINDS,
  MEDIA_TYPES,
  MEDIA_VIDEO_TYPE,
  type MediaType,
} from "@composable-os/sdk";
import { defineObject } from "./types.ts";

export { MEDIA_TYPES, type MediaType };

/** Every `type` a media item may have. */
const ITEM_TYPES = [...MEDIA_TYPES, ...MEDIA_FILE_TYPES, MEDIA_VIDEO_TYPE] as const;

export const mediaObject = defineObject({
  name: "media",
  label: "Media",
  plural: "Media",
  source: "rec_media",
  titleField: "name",
  defaultSort: { field: "createdAt", direction: "desc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    { name: "name", label: "Name", type: "text", column: "name", filterable: true, sortable: true },
    {
      name: "kind",
      label: "Kind",
      type: "enum",
      enumValues: MEDIA_KINDS,
      column: "kind",
      filterable: true,
      sortable: true,
    },
    {
      name: "type",
      label: "Type",
      type: "enum",
      enumValues: ITEM_TYPES,
      column: "type",
      filterable: true,
      sortable: true,
    },
    {
      name: "bytes",
      label: "Size",
      type: "number",
      column: "bytes",
      filterable: true,
      sortable: true,
    },
    {
      name: "width",
      label: "Width",
      type: "number",
      column: "width",
      filterable: true,
      sortable: true,
    },
    {
      name: "height",
      label: "Height",
      type: "number",
      column: "height",
      filterable: true,
      sortable: true,
    },
    {
      name: "state",
      label: "State",
      type: "enum",
      enumValues: ["uploading", "processing", "ready", "failed"],
      column: "state",
      filterable: true,
      sortable: true,
    },
    {
      name: "duration",
      label: "Duration (seconds)",
      type: "number",
      column: "duration",
      filterable: true,
      sortable: true,
    },
    {
      name: "alt",
      label: "Alt text",
      type: "text",
      column: "alt",
      filterable: true,
      sortable: false,
    },
    {
      name: "createdAt",
      label: "Uploaded",
      type: "datetime",
      column: "created_at",
      filterable: true,
      sortable: true,
    },
    {
      name: "createdBy",
      label: "Uploaded by",
      type: "id",
      column: "created_by",
      filterable: true,
      sortable: false,
    },
  ],
});
