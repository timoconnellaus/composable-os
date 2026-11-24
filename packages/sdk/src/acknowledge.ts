// Read and understood (stage 38, ADR 0702): a publishable object may ask the staff who must read
// a record to confirm each version that matters, with one tap.
//
//   publishable: {
//     content: ["title", "body"],
//     acknowledge: { who: "mustRead", manage: "knowledge:manage" },
//   }
//
// `who` names a `document` field of the object's own, outside the content, whose schema is
// MUST_READ_SCHEMA: `{ everyone: true }`, or `{ everyone: false, roles: [...] }` where each entry
// is a staff role (`admin`, `member`, `viewer`), a pack role (`rostering.team`) or a pack
// permission an admin grants (`bookings:desk`). The host reads it on the day, against each
// account's role, pack role and grants. `manage` names a restricted, grantable permission of the
// extension's tools: who holds it (and admins) reads who has confirmed, and changes who must read
// once a record has been published.
import type { DocumentSchema } from "./document.ts";

/** What an entry of `roles` may be: a staff role, `<pack>.<role>` or `<pack>:<permission>`. */
export const MUST_READ_ENTRY_RE =
  /^(?:admin|member|viewer|[a-z][a-z0-9]{1,29}[.:][a-zA-Z0-9]{1,40})$/;

/** The most entries one "must read" lists. */
export const MUST_READ_MAX = 50;

/** The one schema of an acknowledged object's "must read" field. */
export const MUST_READ_SCHEMA: DocumentSchema = {
  root: {
    type: "object",
    fields: {
      everyone: { type: "boolean", description: "Every staff account must read it" },
      roles: {
        type: "array",
        max: MUST_READ_MAX,
        optional: true,
        description: "Staff roles, pack roles and granted pack permissions that must read it",
        of: {
          type: "text",
          min: 1,
          max: 71,
          chars: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:",
        },
      },
    },
  },
};
