/** An email to send through `EmailSendSession.send()`. */
export interface EmailSendMessage {
  /** Recipient addresses (`name@example.com`). 1 to 50 across `to`, `cc` and `bcc` together. */
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** One line, 1 to 998 characters. */
  subject: string;
  /** Plain-text body, up to 32 KiB. At least one of `text` and `html` is required. */
  text?: string;
  /** HTML body, up to 32 KiB. */
  html?: string;
  /** Address replies go to, when it is not the sender. */
  replyTo?: string;
  /**
   * CRM record ids the email is about (up to 20), shown to the approver. Provisional ids of
   * records created earlier in the same change set (such as `per_pending_…`) are fine.
   */
  relatedRecords?: string[];
  /**
   * Makes a retried send safe: a second `send()` with the same key (up to 200 letters, digits or
   * `. _ : -`) answers with the first one's receipt and queues nothing. Use one key per email,
   * stable across retries (an automation's run id and the email's place in it).
   */
  idempotencyKey?: string;
  /**
   * An "add to calendar" file of one event, attached as `invite.ics`. The gatekeeper makes the
   * file from these values (times in UTC); nothing else can be attached. Send the same `uid` with
   * a higher `sequence` for a change, and `cancelled: true` to take it off the calendar.
   */
  calendar?: EmailCalendarEventInput | EmailCalendarEventInput[];
}

/**
 * One event of an email's calendar files. Give one, or two for a move (the old event cancelled,
 * the new one added); each is its own file.
 */
export interface EmailCalendarEventInput {
  /** A stable id of what the event is, such as a record id. */
  uid: string;
  /** ISO 8601 instants; the end after the start, within 7 days. */
  start: string;
  end: string;
  /** One line, up to 200 characters. */
  title: string;
  /** One line, up to 200 characters. */
  location?: string;
  /** Up to 2,000 characters. */
  description?: string;
  /** An https link. */
  url?: string;
  /** 0 to 2,147,483,647; higher on each change. */
  sequence?: number;
  cancelled?: boolean;
}

/** What `EmailSendSession.send()` returns. */
export interface EmailSendReceipt {
  /**
   * `"pending"` until someone approves the send; `"sent"` when it was approved straight away
   * (an email to colleagues the workspace auto-approves).
   */
  status: "pending" | "sent";
  /** The send's id, as `listSent()` reports it. */
  id: number;
}

/** One email in `EmailSendSession.listSent()`. */
export interface EmailSendRecord {
  id: number;
  to: string[];
  subject: string;
  /** `"pending"` awaits approval; `"rejected"` was turned down and never sent. */
  status: "pending" | "sent" | "rejected";
  /** ISO 8601 time the email was handed to Email Service. */
  sentAt?: string;
}

/**
 * Sends email from one sender address. Every send waits for approval before it goes out, except
 * that a workspace may auto-approve email whose every recipient is a colleague. Reads reflect
 * sends still awaiting approval.
 */
export interface EmailSendSession {
  /** Queues an email for approval. Throws on an invalid message. */
  send(message: EmailSendMessage): Promise<EmailSendReceipt>;
  /** Lists recent emails from this sender, newest first, including those awaiting approval. */
  listSent(): Promise<EmailSendRecord[]>;
  /** The sender address email goes out from. */
  getSender(): Promise<string>;
}
