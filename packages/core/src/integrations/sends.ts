// Which outbound actions send to people, and to whom (stage 30, ADR 0678). The host decides it,
// by the gatekeeper's vendor and the action's kind, from the action's description: what the
// approver reads is what the provider will do, so it is where the recipients are. A gatekeeper's
// word ("this is internal", "nobody is told") is taken only where the gatekeeper itself enforces
// it (email-send's `email.internal`: every address at the business's own domains).
//
// - an **outbox** (email-send, the fake outbox): email to `To`, `Cc`, `Bcc`; the gatekeeper asks
//   the host first (`contactCheck`) and can carry a purpose and stop links;
// - a **mailbox** (Gmail's send and draft send, Outlook's send): email to `To`, `Cc`, `Bcc`, sent
//   as the mailbox's owner; no purpose, no stop link;
// - an **invitation** (Google Calendar's create and update unless `Send updates` is `none`,
//   Outlook's `calendar.invitations` and `calendar.responses`): the provider emails the attendees,
//   who are read from the event; no purpose, no stop link;
// - a **scan** (a connected MCP server's tool call): every email address and phone number in its
//   arguments. A server that addresses people by its own ids (a contact id, a list) cannot be
//   checked; an admin who connects a messaging server accepts that.
//
// Everything else (Slack and Google Chat, which reach a staff workspace; documents, sheets, files
// and lists; webhooks; payments and the books) names no one the register knows.

/** A field of an outbound description, as a gatekeeper sends it or as a pending action keeps it. */
export interface DescriptionField {
  label: string;
  value?: string | undefined;
  items?: unknown;
}

export interface DescribedAction {
  title?: string | undefined;
  description?: string | undefined;
  fields?: readonly DescriptionField[] | undefined;
  actionKind?: { tag: string } | null | undefined;
}

export type SendShape = "outbox" | "mailbox" | "invitation" | "scan";

export interface PeopleSend {
  shape: SendShape;
  /** The addresses it goes to, lower-cased. */
  emails: string[];
  /** The numbers it goes to (digits, with a leading +), a scan's only. */
  numbers: string[];
  /** Every recipient is known: false when the provider will tell people the host cannot see. */
  complete: boolean;
  /** An email's `To` recipients and whether it has `Cc` or `Bcc` (a mailbox's one-to-one rule). */
  to: string[];
  copied: boolean;
}

const ADDRESS = /[^\s<>(),;:"'[\]{}\\]+@[^\s<>(),;:"'[\]{}\\]+\.[^\s<>(),;:"'[\]{}\\]+/g;
// An international number: a +, then 8 to 15 digits, spaces, dots, dashes or brackets between.
const NUMBER = /\+\d(?:[\s().-]*\d){7,14}/g;

function fieldText(field: DescriptionField): string {
  return [...(Array.isArray(field.items) ? field.items.map(String) : []), field.value ?? ""].join(
    "\n",
  );
}

function addressesIn(text: string): string[] {
  return [...new Set([...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase()))];
}

function numbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(NUMBER)].map((m) => `+${m[0].replace(/\D/g, "")}`))];
}

function labelled(d: DescribedAction, labels: readonly string[]): string[] {
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  return addressesIn(
    (d.fields ?? [])
      .filter((f) => wanted.has(f.label.trim().toLowerCase()))
      .map(fieldText)
      .join("\n"),
  );
}

function field(d: DescribedAction, label: string): DescriptionField | undefined {
  return (d.fields ?? []).find((f) => f.label.trim().toLowerCase() === label.toLowerCase());
}

function mail(d: DescribedAction, shape: "outbox" | "mailbox"): PeopleSend {
  const to = labelled(d, ["to"]);
  const copies = labelled(d, ["cc", "bcc"]);
  const emails = [...new Set([...to, ...copies])];
  return { shape, emails, numbers: [], complete: emails.length > 0, to, copied: copies.length > 0 };
}

/** The attendees in a Google Calendar event's JSON (`attendees[].email`). */
function attendeesOf(json: string): string[] | null {
  try {
    const parsed = JSON.parse(json) as { attendees?: unknown };
    if (!Array.isArray(parsed.attendees)) return null;
    return parsed.attendees.flatMap((a) =>
      a && typeof a === "object" && typeof (a as { email?: unknown }).email === "string"
        ? [((a as { email: string }).email as string).toLowerCase()]
        : [],
    );
  } catch {
    return null;
  }
}

function invitation(emails: string[], complete: boolean): PeopleSend {
  return {
    shape: "invitation",
    emails: [...new Set(emails)],
    numbers: [],
    complete,
    to: emails,
    copied: false,
  };
}

/** Kinds that send to nobody, by vendor: mail only to colleagues, and drafts. */
const EXEMPT: Readonly<Record<string, ReadonlySet<string>>> = {
  "email-send": new Set(["email.internal"]),
  fake: new Set(["fake.internal"]),
  google: new Set(["draftCreate", "draftUpdate", "draftDelete"]),
  microsoft: new Set(["outlook.drafts"]),
};

/**
 * Whether an outbound action of `vendor` sends to people, and to whom; null when it reaches no
 * one the register knows.
 */
export function peopleSendOf(vendor: string, d: DescribedAction): PeopleSend | null {
  const tag = d.actionKind?.tag ?? null;
  if (tag && EXEMPT[vendor]?.has(tag)) return null;
  switch (vendor) {
    case "email-send":
      return mail(d, "outbox");
    case "fake":
      // The fake's Slack-like workspace is staff only.
      if (tag?.startsWith("fake.slack.")) return null;
      return mail(d, "outbox");
    case "google": {
      // Calendar: the attendees are told unless updates go to nobody.
      const updates = field(d, "Send updates");
      if (updates) {
        if (fieldText(updates).trim() === "none") return null;
        const event = field(d, "Event");
        if (event) {
          const attendees = attendeesOf(fieldText(event));
          // An event with nobody invited tells no one.
          return attendees?.length ? invitation(attendees, true) : null;
        }
        // An update tells the attendees it already has, which its description does not list:
        // only those it adds are known.
        const changes = field(d, "Changes");
        return invitation((changes && attendeesOf(fieldText(changes))) || [], false);
      }
      // Gmail's send and draft send carry no kind; every other Gmail, Chat, Docs, Sheets and
      // Slides kind names one, and none of those sends to people.
      if (tag === null && field(d, "To")) return mail(d, "mailbox");
      return null;
    }
    case "microsoft":
      if (tag === "outlook.send") return mail(d, "mailbox");
      if (tag === "calendar.invitations") {
        const emails = labelled(d, [
          "Invites",
          "Told about the change",
          "Told about the cancellation",
        ]);
        return invitation(emails, emails.length > 0);
      }
      if (tag === "calendar.responses") {
        const emails = labelled(d, ["Organizer"]);
        return invitation(emails, emails.length > 0);
      }
      return null;
    case "mcp": {
      const text = [d.title ?? "", d.description ?? "", ...(d.fields ?? []).map(fieldText)].join(
        "\n",
      );
      const emails = addressesIn(text);
      const numbers = numbersIn(text);
      if (!emails.length && !numbers.length) return null;
      return { shape: "scan", emails, numbers, complete: true, to: [], copied: true };
    }
    default:
      return null;
  }
}
