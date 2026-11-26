// Saved replies (stage 36 step 3, ADR 0749): ready text for a reply, a staff member's own or
// shared by the inbox, with a few fixed slots and never a free merge field.
//
// A free merge field (any field of any record) is a way to put into a message what its reader
// should not see (the spec's "What was weighed and rejected"). The slots are fixed, and the host
// fills them (`fillSlots`) from the conversation the caller may read, the caller's own name and
// the business's name: nothing else reaches a reply this way.
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { CONVERSATION_CHANNELS } from "./index.ts";

/** The fixed slots a saved reply may use, written `{{person.firstName}}` in its words. */
export const SAVED_REPLY_SLOTS = ["person.firstName", "staff.firstName", "business.name"] as const;
export type SavedReplySlot = (typeof SAVED_REPLY_SLOTS)[number];

export const SLOT_LABELS: Record<SavedReplySlot, string> = {
  "person.firstName": "The person's first name",
  "staff.firstName": "Your first name",
  "business.name": "The business's name",
};

export const MAX_SAVED_REPLY_TITLE = 120;
export const MAX_SAVED_REPLY_BODY = 10_000;

const SLOT = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * The slots `body` uses, each once, in the order they first appear. Refuses a slot that is not
 * one of the fixed ones and any `{{` or `}}` left over (a half-written slot).
 */
export function slotsOf(body: string): SavedReplySlot[] {
  const used: SavedReplySlot[] = [];
  for (const match of body.matchAll(SLOT)) {
    const name = match[1] ?? "";
    if (!(SAVED_REPLY_SLOTS as readonly string[]).includes(name)) {
      throw new ValidationError(
        `{{${name}}} is not a slot a saved reply can use. The slots are ${SAVED_REPLY_SLOTS.map((s) => `{{${s}}}`).join(", ")}`,
        { field: "body", slot: name },
      );
    }
    if (!used.includes(name as SavedReplySlot)) used.push(name as SavedReplySlot);
  }
  const rest = body.replace(SLOT, "");
  if (rest.includes("{{") || rest.includes("}}")) {
    throw new ValidationError("A slot is written {{person.firstName}}: close every {{ with }}", {
      field: "body",
    });
  }
  return used;
}

export type SlotValues = Partial<Record<SavedReplySlot, string | null>>;

/**
 * `body` with its slots filled from `values`, and the slots that had no value (filled with
 * nothing, for the person to see and fix before they send).
 */
export function fillSlots(
  body: string,
  values: SlotValues,
): { body: string; missing: SavedReplySlot[] } {
  const missing: SavedReplySlot[] = [];
  const filled = body.replace(SLOT, (_whole, raw: string) => {
    const name = raw.trim() as SavedReplySlot;
    const value = values[name]?.trim();
    if (!value) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return value;
  });
  return { body: filled, missing };
}

/** The first word of a name (a staff member's "first name" when their account has one name). */
export function firstWord(name: string | null | undefined): string | null {
  const word = name?.trim().split(/\s+/)[0];
  return word ? word : null;
}

export const savedReplySchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().describe("Its words, with slots written {{person.firstName}}"),
  channels: z.array(z.enum(CONVERSATION_CHANNELS)).describe("The channels it fits"),
  shared: z.boolean().describe("Shared by the whole inbox; false: the caller's own"),
  owner: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable()
    .describe("Whose own it is; null for a shared one"),
  slots: z.array(z.enum(SAVED_REPLY_SLOTS)),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  canEdit: z.boolean().describe("The caller may change or archive it"),
  updatedAt: z.string(),
  version: z.number().int().describe("Pass back to a write to refuse it if this changed since"),
});
export type SavedReply = z.infer<typeof savedReplySchema>;
