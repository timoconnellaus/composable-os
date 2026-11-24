// Prefixed, time-sortable ids (ADR 0015): `<prefix>_<ulid>`, e.g. `per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y`.
// The ULID part is 48 bits of millisecond time then 80 random bits in Crockford base32, so ids sort
// lexically by creation time. Ids minted in the same millisecond by one isolate stay ordered.

/** The prefix for each kind of id. Add new kinds here; prefixes are short and never reused. */
export const ID_PREFIXES = {
  person: "per",
  organisation: "org",
  affiliation: "aff",
  activity: "act",
  task: "tsk",
  user: "usr",
  view: "vw",
  audit: "aud",
  tag: "tag",
  email: "eml",
  phone: "phn",
  domain: "dom",
  address: "adr",
  /** Records of extension objects (stage 3). */
  record: "rec",
  /** Extension run history rows. */
  extensionRun: "xrn",
  changeSet: "chs",
  pendingAction: "pac",
  connectedApp: "cap",
  /** Integration connections (stage 6, ADR 0050). */
  connection: "con",
  integrationEvent: "iev",
  jobChange: "jcs",
  /** Stage history rows (ADR 0100). */
  stageHistory: "sth",
  dashboard: "dsh",
  /** Automation runs (ADR 0130). */
  automationRun: "arn",
  /** Notifications (ADR 0132). */
  notification: "ntf",
  /** Automation events outbox rows (ADR 0171). */
  outbox: "obx",
  /** Admin notification channel routes (ADR 0172). */
  notificationRoute: "nrt",
  /** In-app assistant conversations (ADR 0200). */
  assistantConversation: "asc",
  /** A person's one assistant thread (ADR 0340). */
  assistantThread: "ath",
  /** A memory line (ADR 0342). */
  memory: "mem",
  /** A personal routine (ADR 0343). */
  routine: "rtn",
  /** Policy adjudicator verdicts (ADR 0204). */
  adjudication: "adj",
  /** Assignment rules (ADR 0246). */
  assignmentRule: "asr",
  /** An agent (ADR 0344). */
  agentJob: "job",
  /** One approval's claim on the actions it applies (ADR 0345). */
  execution: "exe",
  /** A customer account (stage 22, ADR 0402): a Person who can sign in. Never a core_user. */
  customer: "cus",
  /** A request to erase a Person, made when a customer deletes their account (stage 22). */
  eraseRequest: "erq",
  /** An order and one of its lines (stage 25, ADR 0426). */
  order: "ord",
  orderLine: "orl",
  /** Money off an order (stage 34, ADR 0690). */
  orderAdjustment: "oad",
  /** A payment the host made on an order: a recorded one, or its reversal (stage 34, ADR 0694). */
  orderPayment: "opy",
  /** A refund of an order's payment (stage 25, ADR 0429). */
  refund: "rfd",
  /** A subscription the payment provider runs (stage 32a, ADR 0485). */
  subscription: "sbs",
  /** A continuation offer: free until a date for a subscriber moving from elsewhere (ADR 0491). */
  subscriptionOffer: "sof",
  /** A plan change or a pause the host asked a subscription's provider for (ADRs 0530, 0531). */
  subscriptionChange: "sbc",
  /** A native app's signed-in session on the HTTP surface (stage 23, ADR 0419). */
  deviceSession: "dvs",
  /** A change of a customer account's sign-in address, waiting for its code (stage 48, ADR 0712). */
  emailChange: "ech",
  /** Places claimed from a record's capacity (stage 26, ADR 0430). */
  capacityClaim: "clm",
  /** A movement in the stock ledger (stage 37, ADR 0680); a sale's is named after its claim. */
  stockMovement: "stm",
  /** A stock record's time at or below its reorder level (ADR 0681). */
  stockLow: "stl",
  /** A use spent from an allowance holder by a spender (stage 32b, ADR 0493). */
  allowanceUse: "alu",
  /** A Person's one purchase of something sold once per Person (stage 32b, ADR 0512). */
  sellableOnce: "sbo",
  /** An invite for a staff account (ADR 0455). */
  userInvite: "uin",
  // Stage 28 (ADR 0444): a picture of the media library.
  media: "med",
  /** A family link: a guardian and a dependant (stage 31a, ADR 0540). */
  personLink: "pln",
  /** Stage 56 (ADR 0831): a staff account that looks after a Person. */
  personCarer: "pcr",
  /** A kind of note and its template (stage 56 step 2, ADR 0833). */
  noteKind: "nkd",
  /** A Person's check-in code: an app code or a card (stage 51, ADR 0783). */
  personCode: "pc",
  refundDue: "rdu",
  /** A routine email the host was asked to send (ADR 0590). */
  routineMail: "rml",
  /** A code sent to a Person's number to check it (stage 30, ADR 0673). */
  phoneCheck: "phk",
  /** An agreement document (stage 44, ADR 0640). */
  agreementDocument: "agd",
  /** A published version of an agreement document, never changed (stage 44, ADR 0640). */
  agreementVersion: "agv",
  /** One record that a person agreed to one version, never changed (stage 44, ADR 0642). */
  agreementAcceptance: "aga",
  /** A desk signing session on the business's enrolled tablet (stage 44 step 6, ADR 0649). */
  agreementDeskSession: "ads",
  /** A device a human admin enrolled as the business's own (stage 51, ADR 0780). */
  device: "dev",
  /** A shift offered for someone else to take (stage 45, ADR 0623). */
  staffOffer: "sfo",
  /** A time a staff member said they cannot work (stage 45, ADR 0622). */
  staffAway: "saw",
  /** Open hours: when someone takes appointments, weekly or extra (stage 49, ADR 0762). */
  staffHours: "soh",
  /** One locked version of a pay period (stage 45 step 6, ADR 0627). */
  payPeriod: "ppe",
  /** A stretch of time a staff member worked (stage 58, ADR 0850). */
  timeEntry: "tme",
  /** A kind of leave the business offers (stage 58 step 4, ADR 0853). */
  leaveType: "lvt",
  /** An ask for time off, approved, declined or cancelled (ADR 0853). */
  leaveRequest: "lvr",
  /** One entry of a leave balance's ledger, never changed (ADR 0853). */
  leaveBalanceEntry: "lvb",
  /** A checklist template (stage 45 step 4b, ADR 0650). */
  checklist: "ckl",
  /** A run of a checklist on one record, never changed once closed (ADR 0650). */
  checklistRun: "ckr",
  /** A correction added beside a closed checklist run (ADR 0650). */
  checklistNote: "ckn",
  /** One tick of a checklist run's step, never changed (ADR 0650). */
  checklistTick: "ckt",
  /** A quote, an invoice and a credit note, and their lines (stage 35, ADR 0730). */
  quote: "qt",
  quoteLine: "qtl",
  invoice: "inv",
  invoiceLine: "inl",
  creditNote: "cn",
  creditNoteLine: "cnl",
  /** An entry in the accounting outbox, to send to the books once (stage 61). */
  accountingPost: "acp",
  /** A bill-to waiting for a person to choose its contact in the books (stage 61). */
  accountingMatch: "acm",
  /** A conversation in the shared inbox (stage 36, ADR 0740). */
  conversation: "cnv",
  /** A journey: steps the host takes for one Person at a time (stage 53, ADR 0800). */
  journey: "jny",
  /** A published version of a journey, never changed (ADR 0800). */
  journeyVersion: "jnv",
  /** One Person on one journey (ADR 0800). */
  journeyEntry: "jne",
  /** What happened at one step of a journey entry (ADR 0800). */
  journeyStepLog: "jnl",
  /** One closed version of a finance month (stage 52, ADR 0790). */
  financePeriod: "fip",
  /** One list loaded from a business's booking system (stage 65, ADR 0922). */
  outsideList: "osl",
  /** A place the business works from (stage 64, ADR 0910). */
  location: "loc",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];
/** A branded-by-template id string, e.g. `Id<"person">` is `per_${string}`. */
export type Id<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte & 31);
}

/** Adds one to an array of base32 digits; carries left. Overflow is astronomically unlikely. */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ULID random component overflowed within one millisecond");
}

/** A 26-character ULID. Monotonic within an isolate. */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now <= lastTime) {
    random = increment(lastRandom);
    now = lastTime;
  } else {
    random = randomDigits();
    lastTime = now;
  }
  lastRandom = random;

  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((digit) => ALPHABET[digit]).join("");
}

/** A new id for `kind`, e.g. `newId("person")` → `per_01JC…`. */
export function newId<K extends IdKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

/** True when `value` is a well-formed id of `kind`. */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_RE.test(value.slice(prefix.length));
}

/** The creation time encoded in an id (or bare ULID), or null if it is not one. */
export function idTimestamp(id: string): Date | null {
  const ulidPart = id.slice(id.lastIndexOf("_") + 1);
  if (!ULID_RE.test(ulidPart)) return null;
  let time = 0;
  for (const char of ulidPart.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(char);
  return new Date(time);
}

/** Matches a provisional id: `<prefix>_pending_<ulid>` (ADR 0022). */
export const PROVISIONAL_ID_RE = /^[a-z]{2,4}_pending_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROVISIONAL_ANYWHERE_RE = /[a-z]{2,4}_pending_[0-9A-HJKMNP-TV-Z]{26}/g;
const ANY_ID_RE = /[a-z]{2,4}_(?:pending_)?[0-9A-HJKMNP-TV-Z]{26}/g;

/**
 * The provisional id for a record a pending action would create: its dry-run id with `_pending`
 * after the prefix (`per_01J…` → `per_pending_01J…`). It passes the same `startsWith("per_")`
 * input checks, so later pending actions can refer to it, and is bound to the real id on apply.
 */
export function toProvisionalId(id: string): string {
  const at = id.indexOf("_");
  return at < 0 ? id : `${id.slice(0, at)}_pending_${id.slice(at + 1)}`;
}

export function isProvisionalId(value: unknown): value is string {
  return typeof value === "string" && PROVISIONAL_ID_RE.test(value);
}

/** Every provisional id mentioned anywhere in a JSON-like value. */
export function findProvisionalIds(value: unknown): string[] {
  const text = JSON.stringify(value ?? null);
  return [...new Set(text.match(PROVISIONAL_ANYWHERE_RE) ?? [])];
}

/** Every record id (real or provisional) mentioned anywhere in a JSON-like value. */
export function findIds(value: unknown): string[] {
  const text = JSON.stringify(value ?? null);
  return [...new Set(text.match(ANY_ID_RE) ?? [])];
}

/**
 * Deep-replaces ids using `map`, in string values, inside strings such as link keys
 * (`person:per_…`) and in object keys.
 */
export function replaceIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (!map.size) return value;
  const inString = (text: string) => text.replace(ANY_ID_RE, (id) => map.get(id) ?? id);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return inString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [inString(k), walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}
