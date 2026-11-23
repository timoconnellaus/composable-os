// Agreements for a client app (stage 44 step 5): the headless entry the agreement blocks share,
// web and native. Functions and hooks over the typed client, no markup and no platform API: the
// web blocks draw with React DOM and pointer events, the native ones with React Native and its
// touch responder, and both use what is here.
//
// It holds no rules. What is due, for whom, who may agree, whether a purchase or a booking may go
// ahead and whether a signature or an answer is acceptable are the host's (ADR 0401, ADR 0644): a
// block asks (`me.agreements.due`, or the refusal a buying or booking call answers with) and shows
// the answer. The checks here (a box ticked, a name typed, every question answered, enough ink)
// only say what is missing before a call the host checks again in full.
//
// What a person types, draws and answers is personal data, and health answers are health
// information: nothing here logs, stores or sends them anywhere but the one call that agrees.
// They live in a block's memory until that call, and the block forgets them after it.
import { type ClientHolding, type PackClient, packHooks } from "./hooks.ts";

// --- What the host answers ------------------------------------------------------------------------

/** One question of a health form. */
export interface AgreementQuestion {
  key: string;
  text: string;
  noteOnYes: boolean;
}

/** A version as a person reads it before agreeing: the exact words recorded with their agreement. */
export interface AgreementVersion {
  id: string;
  documentId: string;
  number: number;
  kind: string;
  title: string;
  /** Rich text (ADR 0440), without pictures, embeds or buttons. */
  body: unknown;
  tickLabel: string;
  questions: AgreementQuestion[] | null;
  /** Tick and type a name, or type a name and draw a signature: the business's choice. */
  how: "typed" | "drawn";
  effectiveFrom: string;
  hash: string;
}

/** Why a document is due: never agreed, "agree again", asked again after a while, or a guardian's. */
export type DueReason = "never" | "agree_again" | "ask_again" | "guardian";

export interface DueDocument {
  documentId: string;
  kind: string;
  title: string;
  reason: DueReason;
  version: AgreementVersion;
}

/** The caller, or a child linked to them, and what they still have to agree to. */
export interface DuePerson {
  personId: string;
  name: string;
  self: boolean;
  /** False for a person a parent or guardian agrees for: the host refuses their own agreement. */
  canAgree: boolean;
  due: DueDocument[];
}

/** A drawn signature: integer points in a 1000 by 400 box (the host's format, ADR 0642). */
export interface Signature {
  width: 1000;
  height: 400;
  strokes: [number, number][][];
}

export interface HealthAnswer {
  key: string;
  yes: boolean;
  note?: string;
}

/** What agreeing to one version sends: the version shown, and what the person gave. */
export type AgreeInput = {
  versionId: string;
  typedName: string;
  signature?: Signature;
  answers?: HealthAnswer[];
};

export interface AcceptanceSummary {
  id: string;
  documentId: string;
  title: string;
  kind: string;
  versionId: string;
  versionNumber: number;
  personId: string | null;
  by: "self" | "guardian" | "guest" | "paper";
  how: "typed" | "drawn" | "paper";
  channel: "web" | "app" | "paper" | "desk";
  acceptedAt: string;
  /** The guardian who agreed, shown only to that guardian. */
  agentPersonId: string | null;
  recordedBy: string | null;
  signedOn: string | null;
  /** Whether it is the acceptance that counts for its document now. */
  counts: boolean;
}

export interface AcceptanceDetail extends AcceptanceSummary {
  version: AgreementVersion;
  /** Shown only to whoever agreed. */
  typedName: string | null;
  signature: Signature | null;
  answers: HealthAnswer[] | null;
}

export interface Accepted {
  id: string;
  documentId: string;
  versionNumber: number;
  acceptedAt: string;
  /** The address the copy goes to, or null when none is sent. */
  copyTo?: string | null;
}

/** The operations this entry calls, as the generated client types them. */
export type AgreementsOperations = {
  "me.agreements.due": {
    kind: "query";
    input: Record<string, never>;
    output: { people: DuePerson[] };
  };
  "me.agreements.list": {
    kind: "query";
    input: Record<string, never>;
    output: { items: AcceptanceSummary[] };
  };
  "me.agreements.get": { kind: "query"; input: { id: string }; output: AcceptanceDetail };
  "me.agreements.accept": {
    kind: "mutation";
    input: AgreeInput & { forPersonId?: string };
    output: Accepted;
  };
  "agreement.guestVersions": {
    kind: "query";
    input: { versionIds: string[] };
    output: { versions: AgreementVersion[] };
  };
};

export type AgreementsClient = PackClient<AgreementsOperations>;

// --- A refusal from a buying or booking call -------------------------------------------------------

/** A document a refusal names: its version to read, and whose it is (none for a visitor). */
export interface RefusedDocument {
  documentId: string;
  title: string;
  versionId: string;
  personId: string | null;
}

/**
 * Why the host refused, as far as agreements go:
 * - `due`: something must be agreed to first (the documents);
 * - `minor_payer`: the person is a minor and the payer must agree: a parent or guardian buys it;
 * - `changed`: what is due changed while the call was being made: ask again and try once more;
 * - `read_again`: what was agreed to is not what is asked now (a visitor's agreements for an older
 *   version, or a version replaced while the person read it): read what is due again.
 */
export type AgreementRefusal =
  | { kind: "due"; message: string; documents: RefusedDocument[] }
  | { kind: "minor_payer"; message: string; documents: RefusedDocument[] }
  | { kind: "changed"; message: string }
  | { kind: "read_again"; message: string };

export const MINOR_PAYER_WORDS = "A parent or guardian needs to buy this for you.";
const CHANGED_WORDS = "What must be agreed to changed just now. Please read it again.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The host's details of an error: its own, or a pack tool's that carries the host's inside. */
function hostDetails(error: unknown): Record<string, unknown> | null {
  const details = record(record(error)?.details);
  if (!details) return null;
  if (typeof details.rule === "string") return details;
  // A pack tool's refusal (`extension_error`) carries the host's code and details inside.
  const inner = record(details.details);
  return inner && typeof inner.rule === "string" ? inner : null;
}

function refusedDocuments(value: unknown): RefusedDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const d = record(item);
    if (!d || typeof d.documentId !== "string" || typeof d.versionId !== "string") return [];
    return [
      {
        documentId: d.documentId,
        title: typeof d.title === "string" ? d.title : "",
        versionId: d.versionId,
        personId: typeof d.personId === "string" ? d.personId : null,
      },
    ];
  });
}

/**
 * Reads an error from a call that buys, subscribes or books (order.start, subscription.start, a
 * pack's buy or book tool): the host's agreements refusal, or null when it is not one.
 */
export function agreementRefusal(error: unknown): AgreementRefusal | null {
  const details = hostDetails(error);
  if (!details) return null;
  if (details.rule === "agreements_changed") return { kind: "changed", message: CHANGED_WORDS };
  if (details.rule === "agreement_not_asked" || details.rule === "agreement_version_replaced") {
    return { kind: "read_again", message: CHANGED_WORDS };
  }
  if (details.rule !== "agreements_due") return null;
  const documents = refusedDocuments(details.documents);
  if (details.reason === "minor_payer") {
    return { kind: "minor_payer", message: MINOR_PAYER_WORDS, documents };
  }
  return { kind: "due", message: "Something must be agreed to first.", documents };
}

/** Said where a screen has no agreement step yet (Ticketing's and Courses' checkouts). */
export const NO_AGREEMENT_STEP_WORDS =
  "This needs an agreement that can't be given here yet. Ask the business how to agree to it first.";

/**
 * For a screen that buys but cannot show the agreement step: the words for the host's refusal of
 * what must be agreed to first (or for a minor, a parent or guardian buys it), or null when the
 * error is something else.
 */
export function agreementBlockedWords(error: unknown): string | null {
  const refusal = agreementRefusal(error);
  if (!refusal) return null;
  if (refusal.kind === "minor_payer") return refusal.message;
  if (refusal.kind === "due") return NO_AGREEMENT_STEP_WORDS;
  return refusal.message;
}

/**
 * Makes a mutation's call and then forgets it: the mutation's state (its variables: a name typed,
 * a signature, health answers) is reset whether the call succeeded or failed, so the app's cache
 * holds none of it once the call is over. What the person entered stays only in the screen's own
 * state, for as long as the screen needs it.
 */
export async function forgetAfter<I, O>(
  mutation: { mutateAsync(input: I): Promise<O>; reset?: () => void },
  input: I,
): Promise<O> {
  try {
    return await mutation.mutateAsync(input);
  } finally {
    mutation.reset?.();
  }
}

/**
 * What to tell a person whose purchase or booking did not go through, as far as agreements and the
 * connection go: null for anything else (the screen says its own words).
 */
export function purchaseErrorWords(error: unknown): string | null {
  const refusal = agreementRefusal(error);
  if (refusal?.kind === "changed" || refusal?.kind === "read_again") {
    return "What must be agreed to changed just now. Please start again and read it once more.";
  }
  if (refusal?.kind === "minor_payer") return refusal.message;
  if (record(error)?.name === "NetworkError") {
    return "We could not reach the business just now. Check your connection and try again: what you entered is still here.";
  }
  return null;
}

/** What a call made with what is due came to. */
export type AgreementsOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "due"; documents: RefusedDocument[] }
  | { kind: "minor_payer"; message: string; documents: RefusedDocument[] };

/**
 * Makes a buying or booking call and reads the host's answer for agreements. When what is due
 * changed while it was made (`changed`), or a visitor's agreements were for an older version
 * (`read_again`), it calls once more, told why (a visitor drops what is stale on `read_again`);
 * a second such refusal is thrown. Any other error is thrown as it is.
 */
export async function withAgreements<T>(
  call: (previous: AgreementRefusal | null) => Promise<T>,
): Promise<AgreementsOutcome<T>> {
  let previous: AgreementRefusal | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { kind: "done", value: await call(previous) };
    } catch (error) {
      const refusal = agreementRefusal(error);
      if (!refusal) throw error;
      if (refusal.kind === "due") return { kind: "due", documents: refusal.documents };
      if (refusal.kind === "minor_payer") {
        return { kind: "minor_payer", message: refusal.message, documents: refusal.documents };
      }
      if (attempt > 0) throw error;
      previous = refusal;
    }
  }
}

/**
 * The documents a refusal named, matched to what `me.agreements.due` says for each person: what a
 * signed-in member (or a guardian, for a child) reads and agrees to inline. A document no longer
 * due is left out; a person who cannot agree themselves comes back with `canAgree: false`.
 */
export function dueForRefusal(
  people: readonly DuePerson[],
  documents: readonly RefusedDocument[],
): { person: DuePerson; item: DueDocument }[] {
  const out: { person: DuePerson; item: DueDocument }[] = [];
  const self = people.find((p) => p.self);
  for (const doc of documents) {
    const person = doc.personId ? people.find((p) => p.personId === doc.personId) : self;
    const item = person?.due.find((d) => d.documentId === doc.documentId);
    if (
      person &&
      item &&
      !out.some((o) => o.item.documentId === item.documentId && o.person === person)
    ) {
      out.push({ person, item });
    }
  }
  return out;
}

/** "Before you go on": each due document in turn, the caller's first, then each child's. */
export function dueSteps(people: readonly DuePerson[]): { person: DuePerson; item: DueDocument }[] {
  const ordered = [...people].sort((a, b) => Number(b.self) - Number(a.self));
  return ordered.flatMap((person) => person.due.map((item) => ({ person, item })));
}

// --- Words (display only) ----------------------------------------------------------------------------

/** Why a document is asked of a person, in words, or null for a first time. */
export function dueReasonWords(reason: DueReason): string | null {
  switch (reason) {
    case "agree_again":
      return "This has changed since you agreed: please read it and agree again.";
    case "ask_again":
      return "It is time to answer these again.";
    case "guardian":
      return "A parent or guardian agrees to this for you.";
    default:
      return null;
  }
}

/** How an acceptance was made, for the person or a guardian reading it ("Agreed by you"). */
export function agreedByWords(acceptance: AcceptanceSummary, me: string | null): string {
  if (acceptance.by === "paper") {
    return acceptance.signedOn
      ? `Recorded from a paper form signed on ${acceptance.signedOn}`
      : "Recorded from a paper form";
  }
  if (acceptance.channel === "desk") return "Agreed in person on the business's device";
  if (acceptance.by === "guardian") {
    return acceptance.agentPersonId && acceptance.agentPersonId === me
      ? "Agreed by you, as their parent or guardian"
      : "Agreed by a parent or guardian";
  }
  if (acceptance.by === "guest") return "Agreed when buying without an account";
  return acceptance.personId === me ? "Agreed by you" : "Agreed by them";
}

/** "A copy is on its way to …", or a plain confirmation when no copy is sent. */
export function copyWords(accepted: Pick<Accepted, "copyTo">): string {
  return accepted.copyTo
    ? `Thank you. A copy is on its way to ${accepted.copyTo}.`
    : "Thank you: that is recorded.";
}

/**
 * What to tell a person whose agreeing did not go through: in plain words, never a value they
 * gave (the host's messages name a rule only).
 */
export function agreeErrorWords(error: unknown): string {
  const refusal = agreementRefusal(error);
  if (refusal?.kind === "changed" || refusal?.kind === "read_again") {
    return "This changed while you were reading it. Please read it again.";
  }
  const e = record(error);
  const details = hostDetails(error);
  if (details?.rule === "agreement_minor") return "A parent or guardian agrees to this for you.";
  if (e?.name === "NetworkError") {
    return "We could not reach the business just now. Check your connection and try again: what you entered is still here.";
  }
  if (e?.code === "invalid_input" && typeof e.message === "string") return e.message;
  return "That did not go through. Please try again.";
}

/** A moment in the person's own zone, for display ("24 Nov 2026, 09:30"). */
export function agreementTime(iso: string, locale = "en-AU"): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Where a person's own signed PDF downloads from on the app's site (the host's route, ADR 0645). */
export function agreementPdfPath(acceptanceId: string): string {
  return `/api/v1/agreements/acceptances/${encodeURIComponent(acceptanceId)}.pdf`;
}

// --- A document's words ----------------------------------------------------------------------------

/** One run of text, as rich text holds it (ADR 0440). */
export interface AgreementRun {
  type: "text" | "break";
  text?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

/** A block of a document's body that a person reads: everything a version may hold. */
export type AgreementBlock =
  | { type: "paragraph"; content: AgreementRun[] }
  | { type: "heading"; level: number; content: AgreementRun[] }
  | { type: "list"; style: "bullet" | "ordered"; items: AgreementListItem[] }
  | { type: "quote"; content: AgreementRun[]; attribution?: string }
  | { type: "callout"; tone: string; content: AgreementRun[] }
  | { type: "divider" };
export interface AgreementListItem {
  content: AgreementRun[];
  list?: { style: "bullet" | "ordered"; items: AgreementListItem[] };
}

/**
 * The blocks of a version's body a screen draws. A body holds no picture, embed or button (the
 * host refuses them at publish); anything not known here is left out rather than guessed at.
 */
export function documentBlocks(body: unknown): AgreementBlock[] {
  const blocks = record(body)?.blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((b) => {
    const block = record(b);
    switch (block?.type) {
      case "paragraph":
      case "heading":
      case "quote":
      case "callout":
      case "list":
      case "divider":
        return [block as unknown as AgreementBlock];
      default:
        return [];
    }
  });
}

/** A run's text: a link shows its address in full (the host allows only a link whose text it is). */
export function runText(run: AgreementRun): string {
  return run.type === "break" ? "\n" : (run.text ?? "");
}

// --- Agreeing to one version ----------------------------------------------------------------------

/** What the person has given so far, before they agree. In memory only. */
export interface AgreeForm {
  ticked: boolean;
  typedName: string;
  /** Each question's answer by key: yes, no, or not answered yet, and a note on a yes. */
  answers: Record<string, { yes: boolean | null; note: string }>;
}

export function emptyAgreeForm(version: Pick<AgreementVersion, "questions">): AgreeForm {
  const answers: AgreeForm["answers"] = {};
  for (const q of version.questions ?? []) answers[q.key] = { yes: null, note: "" };
  return { ticked: false, typedName: "", answers };
}

/** A field the person still has to fill in: the box, the name, an answer, a note, the signature. */
export interface AgreeProblem {
  field: string;
  message: string;
}

/** The longest name and note the host takes (it checks again). */
export const TYPED_NAME_MAX = 200;
export const NOTE_MAX = 1_000;

/** What is missing before agreeing, field by field, in the order the screen shows them. */
export function agreeProblems(
  version: Pick<AgreementVersion, "questions" | "how" | "tickLabel">,
  form: AgreeForm,
  signature: Signature | null,
): AgreeProblem[] {
  const problems: AgreeProblem[] = [];
  for (const q of version.questions ?? []) {
    const answer = form.answers[q.key];
    if (!answer || answer.yes === null) {
      problems.push({ field: `answer:${q.key}`, message: "Answer yes or no" });
    } else if (answer.yes && answer.note.trim().length > NOTE_MAX) {
      problems.push({ field: `note:${q.key}`, message: "A note is at most 1,000 characters" });
    }
  }
  if (!form.ticked) problems.push({ field: "ticked", message: "Tick the box to agree" });
  const name = form.typedName.trim();
  if (!name) problems.push({ field: "typedName", message: "Type your name" });
  else if (name.length > TYPED_NAME_MAX) {
    problems.push({ field: "typedName", message: "A name is at most 200 characters" });
  }
  if (version.how === "drawn" && !signatureEnough(signature)) {
    problems.push({ field: "signature", message: "Draw your signature in the box" });
  }
  return problems;
}

/** The call's input: the version the screen showed, and only what this version asks for. */
export function agreeInput(
  version: Pick<AgreementVersion, "id" | "questions" | "how">,
  form: AgreeForm,
  signature: Signature | null,
): AgreeInput {
  const input: AgreeInput = { versionId: version.id, typedName: form.typedName.trim() };
  if (version.how === "drawn" && signature) input.signature = signature;
  if (version.questions?.length) {
    input.answers = version.questions.map((q) => {
      const answer = form.answers[q.key];
      const yes = answer?.yes === true;
      const note = yes && q.noteOnYes ? (answer?.note.trim() ?? "") : "";
      return note ? { key: q.key, yes, note } : { key: q.key, yes };
    });
  }
  return input;
}

// --- A drawn signature -----------------------------------------------------------------------------

/** The box a signature is drawn in, and the most it may hold (the host's limits, ADR 0642). */
export const SIGNATURE_BOX = { width: 1000, height: 400 } as const;
export const SIGNATURE_LIMITS = {
  strokes: 30,
  points: 5_000,
  bytes: 32_768,
  /** The least ink, in box units, the host takes as a signature (not a dot or a tap). */
  minLength: 120,
} as const;

/** Points closer than this to the last one (box units) add nothing a screen can show. */
const MIN_STEP = 2;
/** Room kept under the host's byte limit. */
const BYTES_BUDGET = SIGNATURE_LIMITS.bytes - 256;
/** `{"width":1000,"height":400,"strokes":[` and `]}`. */
const BASE_BYTES = 39;

/** The length of the lines a signature draws (a dot draws none). */
export function inkLength(strokes: readonly (readonly (readonly [number, number])[])[]): number {
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [x0, y0] = stroke[i - 1] as readonly [number, number];
      const [x1, y1] = stroke[i] as readonly [number, number];
      total += Math.hypot(x1 - x0, y1 - y0);
    }
  }
  return total;
}

/** Whether a signature has the ink the host takes as one (it checks again). */
export function signatureEnough(signature: Signature | null): boolean {
  return !!signature && inkLength(signature.strokes) >= SIGNATURE_LIMITS.minLength;
}

/**
 * A point on the drawing area, in the signature's box: `x` and `y` are the pointer's position
 * relative to the area's top-left corner, `width` and `height` the area's size on screen.
 * Integer, and kept inside the box.
 */
export function boxPoint(x: number, y: number, width: number, height: number): [number, number] {
  const scale = (v: number, size: number, max: number) => {
    if (!Number.isFinite(v) || !Number.isFinite(size) || size <= 0) return 0;
    return Math.min(max, Math.max(0, Math.round((v / size) * max)));
  };
  return [scale(x, width, SIGNATURE_BOX.width), scale(y, height, SIGNATURE_BOX.height)];
}

const pointBytes = ([x, y]: readonly [number, number]) => 3 + String(x).length + String(y).length;

/**
 * Records a drawn signature as the host takes it: strokes of integer points in the box, within
 * its limits on strokes, points and size. Drawing past a limit stops adding (`full`), so what is
 * sent is never refused for its size. The web pad feeds it pointer events, the native one its
 * touch responder's.
 */
export class StrokeRecorder {
  private lines: [number, number][][] = [];
  private points = 0;
  private bytes = BASE_BYTES;
  private drawing = false;
  /** The pointer drawing the stroke now (a finger, a pen): others are ignored until it lifts. */
  private active: number | null = null;
  /** Drawing went past a limit: nothing more is added until it is cleared. */
  full = false;

  /**
   * A new stroke at `point` (a pen, a finger or the mouse button down). `pointer` names the
   * pointer: while one is drawing, another (a second finger, a palm) starts nothing. False when
   * nothing was started.
   */
  begin(point: readonly [number, number], pointer?: number): boolean {
    if (this.drawing && this.active !== null && pointer !== this.active) return false;
    if (this.full) return false;
    const cost = 2 + (this.lines.length ? 1 : 0) + pointBytes(point);
    if (
      this.lines.length >= SIGNATURE_LIMITS.strokes ||
      this.points + 1 > SIGNATURE_LIMITS.points ||
      this.bytes + cost > BYTES_BUDGET
    ) {
      this.full = true;
      return false;
    }
    this.lines.push([[point[0], point[1]]]);
    this.points += 1;
    this.bytes += cost;
    this.drawing = true;
    this.active = pointer ?? null;
    return true;
  }

  /** The stroke goes on to `point`. False when nothing was added (another pointer's move too). */
  extend(point: readonly [number, number], pointer?: number): boolean {
    if (!this.drawing || this.full) return false;
    if (this.active !== null && pointer !== this.active) return false;
    const stroke = this.lines[this.lines.length - 1];
    const last = stroke?.[stroke.length - 1];
    if (!stroke || !last) return false;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < MIN_STEP) return false;
    const cost = 1 + pointBytes(point);
    if (this.points + 1 > SIGNATURE_LIMITS.points || this.bytes + cost > BYTES_BUDGET) {
      this.full = true;
      this.drawing = false;
      return false;
    }
    stroke.push([point[0], point[1]]);
    this.points += 1;
    this.bytes += cost;
    return true;
  }

  /** The pen, finger or button is lifted (another pointer lifting ends nothing). */
  end(pointer?: number): void {
    if (this.active !== null && pointer !== undefined && pointer !== this.active) return;
    this.drawing = false;
    this.active = null;
  }

  /** Starts again, with nothing drawn. */
  clear(): void {
    this.lines = [];
    this.points = 0;
    this.bytes = BASE_BYTES;
    this.drawing = false;
    this.active = null;
    this.full = false;
  }

  /** The strokes so far (for drawing them on screen). */
  get strokes(): readonly (readonly [number, number])[][] {
    return this.lines;
  }

  /** The signature to send, or null when nothing is drawn. */
  signature(): Signature | null {
    if (!this.lines.length) return null;
    return {
      width: SIGNATURE_BOX.width,
      height: SIGNATURE_BOX.height,
      strokes: this.lines.map((s) => s.map(([x, y]) => [x, y] as [number, number])),
    };
  }
}

/** An SVG path for one stroke, in the box's units ("M x y L x y …"; a dot is a short line). */
export function strokePath(stroke: readonly (readonly [number, number])[]): string {
  const [first, ...rest] = stroke;
  if (!first) return "";
  if (!rest.length) return `M ${first[0]} ${first[1]} l 0.5 0`;
  return `M ${first[0]} ${first[1]} ${rest.map(([x, y]) => `L ${x} ${y}`).join(" ")}`;
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type AgreementsUseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  gcTime?: number;
}) => { data: T | undefined; isPending: boolean; error: unknown; refetch?: () => unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type AgreementsUseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  gcTime?: number;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
  reset?: () => void;
};

/** The operations each hook calls (ADR 0453). */
export const AGREEMENTS_HOOKS_CALL = {
  useDue: ["me.agreements.due"],
  useMine: ["me.agreements.list"],
  useAcceptance: ["me.agreements.get"],
  useAccept: ["me.agreements.accept"],
  useGuestVersions: ["agreement.guestVersions"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const agreements = createAgreementsHooks({ useQuery, useMutation }, api)`, with the customer's
 * generated client. The hooks it cannot back are not there.
 */
export function createAgreementsHooks<C extends ClientHolding>(
  react: { useQuery: AgreementsUseQuery; useMutation: AgreementsUseMutation },
  client: C,
) {
  return packHooks(client, AGREEMENTS_HOOKS_CALL, (api: AgreementsClient) =>
    allAgreementsHooks(react, api),
  );
}

function allAgreementsHooks(
  react: { useQuery: AgreementsUseQuery; useMutation: AgreementsUseMutation },
  api: AgreementsClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** What the signed-in customer, and each child linked to them, still has to agree to. */
    useDue() {
      return useQuery(api.query("me.agreements.due", {}));
    },
    /** Their agreements and their children's, newest first. */
    useMine() {
      return useQuery(api.query("me.agreements.list", {}));
    },
    /**
     * One acceptance, with what it holds (a name typed, a signature, health answers): kept in
     * the app's cache no longer than it is on screen.
     */
    useAcceptance(id: string | null) {
      return useQuery({
        ...api.query("me.agreements.get", { id: id ?? "" }),
        enabled: !!id,
        gcTime: 0,
      });
    },
    /**
     * Agree to a version, for themselves or a child (`forPersonId`). What was sent is not kept
     * once the call is over.
     */
    useAccept() {
      return useMutation({ ...api.mutation("me.agreements.accept"), gcTime: 0 });
    },
    /** A visitor's: the words of the versions a buying call's refusal named. */
    useGuestVersions(versionIds: readonly string[]) {
      return useQuery({
        ...api.query("agreement.guestVersions", { versionIds: [...versionIds] }),
        enabled: versionIds.length > 0,
      });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<AgreementsHooks, "useDue">`. */
export type AgreementsHooks = ReturnType<typeof allAgreementsHooks>;
