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

// --- The pack's words and what else the host guards (stage 38 step 5, ADR 0706) -----------------
//
//   acknowledge: {
//     who: "mustRead",
//     manage: "knowledge:manage",
//     managed: ["reviewEvery"],
//     owner: "owner",
//     notices: {
//       asked: { title: "Please read: {record}" },
//       reminder: { title: "Still to read: {record}", afterDays: 7 },
//       outstanding: { title: "Not yet confirmed: {record}" },
//       welcome: { title: "Procedures to read" },
//     },
//   }
//
// `managed` names more fields of the object's own, outside the content, that the host guards as
// it guards who must read: a person's to change, never an AI actor's, and once the record has
// been published, only an admin's or a holder of `manage`. `owner` names a `user` field: who
// looks after the record, told each week who has not confirmed it. `notices` are the pack's
// words; the host sends them, to the people only it can work out (who must read, who has not), and
// `{record}` stands for the record's published title. Each notice is optional: left out, none.

/** One notice's words: `{record}` in either stands for the record's title. */
export interface AcknowledgeNotice {
  title: string;
  body?: string;
}

/** The notices the host sends for an acknowledged object (ADR 0706). */
export interface AcknowledgeNotices {
  /** A version that asks everyone goes live: to everyone who must read it, once per version. */
  asked?: AcknowledgeNotice;
  /** Still to read `afterDays` after it became theirs to read: to that person, once per version. */
  reminder?: AcknowledgeNotice & { afterDays: number };
  /** Each week while anyone has not confirmed: to the record's `owner`. */
  outstanding?: AcknowledgeNotice;
  /** A new staff account with records to read: to that person, once, listing them. */
  welcome?: AcknowledgeNotice;
}

/** `publishable.acknowledge`: see the comment above and ADRs 0702 and 0706. */
export interface AcknowledgeSpec {
  who: string;
  manage: string;
  managed?: readonly string[];
  owner?: string;
  notices?: AcknowledgeNotices;
}

/** The longest a notice's title and body may be. */
export const ACKNOWLEDGE_NOTICE_TITLE_MAX = 120;
export const ACKNOWLEDGE_NOTICE_BODY_MAX = 600;
/** The longest a reminder may wait, in days. */
export const ACKNOWLEDGE_REMINDER_MAX_DAYS = 60;
