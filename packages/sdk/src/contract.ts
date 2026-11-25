// The extension contract (ADR 0005, ADR 0023): one entry file whose default export is
// `defineExtension({...})`. Everything here is plain data plus tool/automation handlers, so the host
// can turn it into a JSON manifest, validate it, diff it and reconcile it to tables.
import type { z } from "zod";
import type { AgreementsSpec, HealthNotesSpec } from "./agreements.ts";
import type { AllowanceSpec } from "./allowance.ts";
import type { AutomationSpec } from "./automation.ts";
import type { CalendarEntrySpec } from "./calendar-entry.ts";
import type { CapacitySpec, ClaimsSpec } from "./capacity.ts";
import type { ChecklistsSpec } from "./checklists.ts";
import type { DiscountSpec } from "./discount.ts";
import type { DocumentPathSpec, DocumentSchema } from "./document.ts";
import type { FieldTypeName } from "./field-types.ts";
import type { IntakeSpec } from "./intake.ts";
import type { JourneySignalSpec } from "./journey-signals.ts";
import type { MineSpec } from "./mine.ts";
import type { OccupiesSpec } from "./occupies.ts";
import type { RecurringScheduleSpec } from "./recurring.ts";
import type { RoutineMailModule, RoutineMailSpec } from "./routine-mail.ts";
import type { SellableSpec } from "./sellable.ts";
import type { StaffedSpec } from "./staffed.ts";
import type { StatesSpec } from "./states.ts";
import type { StockMovesSpec, StockSpec } from "./stock.ts";
import type { TeamSpec } from "./team.ts";
import type { UniqueSpec } from "./unique.ts";
import type { WorkedOnSpec } from "./worked-on.ts";

/** The contract version this SDK writes. The host accepts this and the previous version. */
export const CONTRACT_VERSION = 1;
/** Contract versions a host built with this SDK runs (current and previous, ADR 0005). */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [CONTRACT_VERSION];

/**
 * Gatekeepers code can reach as `codemode:<gatekeeper>` host modules (stage 6a, ADR 0050): the
 * only way out to an external service. Calls go through the integration host as the caller,
 * reads are observations and side effects are outbound actions under the approval gate.
 */
export const GATEKEEPER_MODULES = [
  "google",
  "microsoft",
  "slack",
  "slack-post",
  "mcp",
  "email",
  "email-send",
  "zoominfo",
  "websearch",
  "webhook",
  // The fake provider: development and tests only (it answers only when turned on).
  "fake",
] as const;
export type GatekeeperModuleName = (typeof GATEKEEPER_MODULES)[number];

/** Host modules an extension can ask for (ADR 0025). There is no HTTP module. */
export const HOST_MODULES = [
  "ops",
  "storage",
  "log",
  "ai",
  // Routine mail (ADR 0590): a shipped pack's declared emails, in its automations only.
  "routine-mail",
  ...GATEKEEPER_MODULES,
] as const;
export type HostModuleName = (typeof HOST_MODULES)[number];

/** Risk classes an extension tool may declare (schema and extension risks are host-only). */
export const TOOL_RISKS = ["read", "write", "bulk-write", "destructive"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

// ---------------------------------------------------------------------------------------------
// Fields

interface FieldBase {
  /** Label shown in the UI. */
  label: string;
  /** Help text for people and models. */
  description?: string;
  /** `timeline`: changes post a system activity on the record (ADR 0017). */
  track?: "timeline";
  /** The field's previous name. Without it a missing field is a removal (hidden, kept 30 days). */
  renamedFrom?: string;
  /** Refuse records without a value. */
  required?: boolean;
  /**
   * Maintained by the host (for example a stage behaviour's won/lost date) or by this
   * extension's own tools and automations, never written by other callers of record operations.
   * Shown, filtered and sorted like any field.
   */
  readOnly?: boolean;
  /**
   * The value a new record gets when none is given (ADR 0246): a text, number, boolean, date or
   * select value of the field's type. Fields of your own objects only.
   */
  default?: string | number | boolean;
  /**
   * Like `default`, but read from one of this extension's settings when the record is created,
   * so admins choose it (a lead's source). Wins over `default` when the setting has a value.
   */
  defaultSetting?: string;
  /**
   * A person's to change (ADR 0507): a write that sets it, made by the assistant, an MCP client,
   * an automation or extension code, always waits for a person's approval, as publishing does
   * (ADR 0480). A gym's booking rules.
   */
  personApproves?: boolean;
}

export type SelectOption =
  | string
  | {
      value: string;
      label?: string;
      color?: string;
      /**
       * Fields that must have a value for a record to hold this choice (a stage rule, ADR 0058).
       * Moving a record to it without them is refused by the update operation, naming the field,
       * so a board drag asks for it.
       */
      requires?: string[];
      /**
       * With `editableOptions`: admins can relabel, recolour and reorder this option but not
       * remove it (the extension's code relies on it).
       */
      fixed?: boolean;
    };

export type FieldSpec =
  | (FieldBase & {
      type:
        | "text"
        | "longText"
        | "date"
        | "datetime"
        | "boolean"
        | "user"
        | "email"
        | "phone"
        | "url"
        | "timezone";
    })
  | (FieldBase &
      NumberBounds & {
        type: "number" | "percent";
      })
  | (FieldBase &
      NumberBounds & {
        type: "currency";
        /** ISO 4217 code shown with the value. Default USD. */
        currency?: string;
      })
  | (FieldBase & {
      type: "select" | "multiSelect";
      options: readonly SelectOption[];
      /**
       * Admins can edit the options in Settings → Extensions (ADR 0246): add, relabel, recolour,
       * reorder, and remove options not marked `fixed`. The declared options are the defaults.
       */
      editableOptions?: boolean;
    })
  | (FieldBase & {
      type: "relation";
      /** Target object: `person`, `organisation`, `task`, or `<extension>.<object>`. */
      to: string;
      /** Many records (stored as a JSON array of ids). Default one. */
      many?: boolean;
    })
  | (Omit<FieldBase, "default" | "defaultSetting" | "track"> & {
      /**
       * One JSON document checked against `schema` on every write, by every actor (ADR 0445).
       * A fault is refused with its path. `maxBytes` (default 65,536, at most 524,288) limits
       * its JSON. `paths` show values inside it as read-only columns of the object's rec_* view,
       * to list, filter, sort and chart by. A `private` object node is removed from what a
       * customer or the public reads.
       */
      type: "document";
      schema: DocumentSchema;
      maxBytes?: number;
      paths?: Record<string, DocumentPathSpec>;
    })
  | (Omit<FieldBase, "default" | "defaultSetting" | "track"> & {
      /**
       * Structured prose (stage 28, ADR 0440): a document with the platform's one schema,
       * `RICH_TEXT_SCHEMA` (paragraphs, headings, lists, quotes, pictures, dividers, embeds,
       * callouts and buttons; bold, italic, code and links). HTML, script and anything the
       * schema does not name are refused on every write. `maxBytes` defaults to 131,072.
       */
      type: "richText";
      maxBytes?: number;
    })
  | (Omit<FieldBase, "default" | "defaultSetting"> & {
      /**
       * A checklist (stage 45 step 4b, ADR 0650): one of the business's checklist templates
       * (Settings → Checklists), by id; only an active one may be picked. Named by an object's
       * `checklists.template`, it gives each record a run of it to tick off.
       */
      type: "checklist";
    })
  | (Omit<FieldBase, "default" | "defaultSetting"> & {
      /**
       * A record's address (stage 28, ADR 0442): lowercase letters and digits in words joined
       * by hyphens, at most 120 characters, unique among the object's live records. Left empty
       * on a new record, the host makes one from the title. Name it as `publishable.slug`.
       */
      type: "slug";
    })
  | (Omit<FieldBase, "default" | "defaultSetting" | "track"> & {
      /**
       * A picture from the media library (stage 28, ADR 0444): `{ media, alt, focal? }`, the
       * media item's id (a live one, checked on write), its alt text and the point to keep in
       * view when a client crops it. Published content's pictures are served to the public.
       */
      type: "image";
    })
  | (Omit<FieldBase, "default" | "defaultSetting" | "track"> & {
      /**
       * A video from the media library (stage 42, ADR 0475): `{ media, poster? }`, a video held in
       * Cloudflare Stream (a ready one, checked on write) and a picture to show before it plays.
       * Every video needs a token the host signs to play (`media.play`); the id alone plays
       * nothing.
       */
      type: "video";
    })
  | (Omit<FieldBase, "required"> & {
      type: "formula";
      /** An expression over fields of the same record. See the SDK README for the grammar. */
      expression: string;
    });

/**
 * Bounds of a number field (stage 41): the host refuses a value below `min`, above `max`, or not
 * a multiple of `step` from `min` (or from 0), for every actor, in imports and in the dry run.
 * An RPE is `{ min: 1, max: 10, step: 0.5 }`; a count of reps `{ min: 0, step: 1 }`.
 */
export interface NumberBounds {
  min?: number;
  max?: number;
  step?: number;
}

export type FieldSpecs = Record<string, FieldSpec>;

// ---------------------------------------------------------------------------------------------
// Objects, views

export interface ObjectSpec {
  label: string;
  plural: string;
  /** A lucide icon name, e.g. `folder-kanban`. */
  icon?: string;
  /** The field used as the record's title (a text-like field). */
  titleField: string;
  description?: string;
  /** The object's previous name, when renaming. */
  renamedFrom?: string;
  fields: FieldSpecs;
  /**
   * Where the object is listed: `main` (the sidebar, default), `settings` (set-up records such as
   * pipelines, listed under Settings → Extensions) or `none` (reached from other records only).
   */
  navigation?: "main" | "settings" | "none";
  /**
   * Indexes on the object's table, each a list of up to 4 own, single-valued, non-formula fields
   * (or `createdAt` / `updatedAt`). They cover live rows only. Declare one for every field the
   * object's hot lists filter or sort by.
   */
  indexes?: readonly (readonly string[])[];
  /**
   * Relation fields (one record each) whose records also get this object's timeline posts, e.g.
   * `["organisation"]` posts a deal's stage moves on its organisation's timeline too.
   */
  timelineLinks?: readonly string[];
  /** A pipeline-like stage behaviour (see StagesSpec). */
  stages?: StagesSpec;
  /** A limited number of places, never given out twice (see CapacitySpec, ADR 0430). */
  capacity?: CapacitySpec;
  /** Something that can be bought, and what a paid line grants (see SellableSpec, ADR 0435). */
  sellable?: SellableSpec;
  /** Things counted on a shelf, sold from a ledger the host keeps (see StockSpec, ADR 0680). */
  stock?: StockSpec;
  /** A record's state moves stock: received adds, a write-off removes, a count sets (see StockMovesSpec, ADR 0681). */
  stockMoves?: StockMovesSpec;
  /**
   * Uses a record holds (a pass, a membership), or a record that spends one (a booking): see
   * AllowanceSpec, ADRs 0493 and 0494. The host counts and refuses a spend past the limit.
   */
  allowance?: AllowanceSpec;
  /**
   * Records that are discounts (see DiscountSpec, ADR 0693): a code or a member's price, worked out
   * by the host when it prices an order, one deal per order, limits kept by the database.
   */
  discount?: DiscountSpec;
  /**
   * An agreement point (see AgreementsSpec, ADR 0641): where a business may need a person to have
   * agreed to its documents first. The business attaches the documents; the pack names the place.
   */
  agreements?: AgreementsSpec;
  /**
   * A health-note list (see HealthNotesSpec, ADR 0643): this object's records make a list staff
   * read (a class's bookings), on which the host may mark a yes on someone's health form.
   */
  healthNotes?: HealthNotesSpec;
  /** A fixed state machine (see StatesSpec, ADR 0425). An object has stages or states, not both. */
  states?: StatesSpec;
  /**
   * A capacity claimant (see ClaimsSpec, ADR 0501): the record's own states hold, take and give
   * back one place on the record its relation `on` points to (a booking on its class).
   */
  claims?: ClaimsSpec;
  /**
   * Uniqueness among live records in some states (see UniqueSpec, ADR 0502): one active booking
   * per Person per class. Refused by the database for every actor.
   */
  unique?: readonly UniqueSpec[];
  /**
   * A weekly schedule that generates dated records of another object (see RecurringScheduleSpec,
   * ADR 0500): a timetable's series and its classes.
   */
  recurring?: RecurringScheduleSpec;
  /**
   * A shift (see StaffedSpec, ADR 0621): who works the record, when, and on what kind of work.
   * The host refuses, in the database, one account on two overlapping shifts, and answers each
   * write with its warnings (away, not qualified, no one on it).
   */
  staffed?: StaffedSpec;
  /**
   * Time can be recorded against the record (see WorkedOnSpec, ADR 0850): a job. Its time is the
   * staff's time entries against it, read through the host; it keeps no hours of its own.
   */
  workedOn?: WorkedOnSpec;
  /**
   * Who on the staff looks after the Person a record is about (see TeamSpec, ADR 0831): the
   * accounts in its user fields while it is live. A pack role's `looksAfter` reaches records
   * only for those People (ADR 0889). Only shipped extensions and an org's own may declare it.
   */
  team?: TeamSpec;
  /**
   * A claim on a thing (see OccupiesSpec, ADR 0765): while live, the record takes the room (or
   * chair, or hall) it names for its time. The host refuses, in the database, a second live
   * record on the same thing at an overlapping time, whatever object it is.
   */
  occupies?: OccupiesSpec;
  /**
   * Events in the customer's private calendar feed (see CalendarEntrySpec, ADR 0891): the record's
   * start, end, public title and place as paths the customer may read, and the states in which it
   * shows. The host reads them as the customer, through the visibility seam, and shows a live
   * dependant's to their guardian. Only shipped extensions may declare it.
   */
  calendarEntry?: CalendarEntrySpec;
  /**
   * The public-write door (see IntakeSpec, ADR 0720): a form the public answers, the submission
   * the host makes from the answers, or another pack's record a form may also make. Only the
   * host's `intake.submit` creates a submission; nothing else opens a write to the public.
   */
  intake?: IntakeSpec;
  /**
   * A checklist the record's person ticks off (see ChecklistsSpec, ADR 0650): a run of the
   * template its `template` field names, made by the host, ticked by the person (or by someone who
   * rosters, for them), never changed once done, read only by the person and those who roster.
   */
  checklists?: ChecklistsSpec;
  /**
   * The record's owner: a `user` field of this object (ADR 0246, stage 14). Assignment rules set
   * it when a record is created without one, and stage 14's visibility policies read it.
   */
  owner?: string;
  /**
   * The object's customer (ADR 0402): whose record it is, and what that customer may read and
   * write, field by field. `field` is a relation to one person. A signed-in customer sees only
   * records where it is their own Person, and of those only the fields in `read`. Fields in
   * `write` (a subset of `read`) are the ones they may set. Left out, the object does not exist
   * for customers. Only shipped extensions and an org's own may declare it; a runtime extension
   * fails `check`.
   */
  customer?: CustomerSpec;
  /**
   * What the public may read of this object (ADR 0438): the fields in `read`, of the records that
   * meet `when`. Deny by default: left out, the public sees nothing of it, and a record that does
   * not meet `when` is not found. A signed-in customer reads it too, unless the object declares a
   * `customer` (an object declares one or the other, except a publishable object with an author:
   * see `publishable`). The public reaches it only through a pack's tool open to them
   * (`public.list`, `public.get`). Only shipped extensions and an org's own may declare it.
   */
  public?: PublicSpec;
  /**
   * What every signed-in customer may read of this object (ADR 0447), whoever's record it is:
   * the fields in `read`, of the records that meet `when` (the shape of `public.when`), or of
   * every live record without it. Beside a `customer` declaration it shares those records with
   * every signed-in customer while each still reads and writes their own as before (a class's
   * sessions beside a client's own); on its own it opens the records to read only (an exercise
   * bank). Never read by the public. Only shipped extensions and an org's own may declare it.
   */
  signedIn?: SignedInSpec;
  /**
   * What a customer may read of a record that one of their own records points to (ADR 0439):
   * the fields in `read`, of the records that a record of `from` (an object of this extension
   * that declares a `customer`) whose customer is the caller points to through its relation
   * `field`. A ticket's holder reads its event's name, times and venue whatever the event's
   * state. Deny by default: left out, a customer reads nothing of this object through their own
   * records. An object that declares a `customer` cannot declare it; one that declares `public`
   * or `signedIn` can, and a customer then reads both. Only shipped extensions and an org's own
   * may declare it.
   */
  customerVia?: CustomerViaSpec;
  /**
   * Who holds access to a record (stage 42, ADR 0477): a customer for whom one of `sources` is
   * live (an enrolment of theirs pointing at it, or at a bundle that lists it). The parts of a
   * document field this object's schema marks `holders` are read only by a holder; everyone
   * else who may read the record reads it without them. The host asks one question for every
   * read and for `media.play`; a block, a hook or a client app is only told the answer. Only
   * shipped extensions and an org's own may declare it.
   */
  access?: AccessSpec;
  /**
   * A working copy staff edit and published versions (ADR 0446): `content` names the fields a
   * version keeps. `record.publish` snapshots them as the next version (a person with the
   * publish permission, never an AI actor); `record.versions` and `record.version` read them;
   * `record.restoreVersion` copies one back into the working copy. Editing the working copy
   * never changes a version. Records get read-only `publishedVersion` and `publishedAt`.
   *
   * With an author (ADR 0810): a publishable object may declare a `customer`, the record's author
   * (a review's writer). The author reads and writes their working copy through `customer`; the
   * public reads only the published version through `public` (which may then be declared too),
   * listed by `content.list` and never by an address (no `slug`). The fields in `customer.write`
   * are the author's alone: staff, the assistant, MCP clients, automations and the extension's own
   * code are refused them on every path, so a published version is always the author's words.
   * Staff still publish, unpublish and move the record's states.
   */
  publishable?: PublishableSpec;
  /** Position in the sidebar among extension objects (lower first). Default 100. */
  navigationOrder?: number;
  /**
   * Groups of fields of which a record must have at least one (ADR 0246): `[["person",
   * "organisation"]]` refuses a lead with neither. Checked by the host on every create and update.
   */
  requireOneOf?: readonly (readonly string[])[];
  /**
   * Names a record created without a title (ADR 0246): the title of the first of these relation
   * fields that has a value, then `suffix` (a lead is "Ada Lovelace lead"). The title field can
   * then be left blank in the create form.
   */
  titleDefault?: { from: readonly string[]; suffix?: string };
  /**
   * Records created once, when the object is first installed (default pipelines and stages).
   * Keyed by a seed key (camelCase); a relation value `{ seed: "<key>" }` points at another seed
   * record of the relation's target (one of this extension's objects). Later releases never
   * re-apply seeds, so people can edit or delete seeded records.
   */
  seed?: Record<string, Record<string, unknown>>;
}

/** Stage types every stage object distinguishes. */
export const STAGE_TYPES = ["open", "won", "lost"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

/**
 * A stage behaviour (ADR 0100): the object moves through ordered stages (records of another of the
 * extension's objects), optionally grouped (pipelines). The host enforces it in the record
 * operations, so it applies to every actor: people, MCP clients, Code Mode, extensions.
 *
 * - Entering a stage needs the stage's required fields and `requiredByType[type]` to have values;
 *   otherwise the write is refused with a structured error naming the missing fields. A read-only
 *   field may be required: a fact the host sets, which no caller can supply (ADR 0750).
 * - `group` must match the stage's group; a record given only a group starts in its first stage.
 * - `probability.field` follows the stage's default probability unless it was set by hand
 *   (`probability.overridden` is then true; clearing that flag resets it).
 * - `closedDate` is set on entering a won or lost stage and cleared on reopening; `status` mirrors
 *   the stage type.
 * - Every stage change is recorded in stage history (entered and left times) and, when the field
 *   is tracked, posted on the timeline as "Moved to <stage>".
 */
export interface StagesSpec {
  /** This object's relation field (one) holding its stage. */
  field: string;
  /** Fields of the stage object (the relation's target). */
  stage: {
    /** A select whose option values include `open`, `won` and `lost`. */
    type: string;
    /** A number field ordering stages within their group. */
    order: string;
    /** A multiSelect whose option values are this object's field names. */
    requiredFields?: string;
    /** A number or percent field: the default probability of records in the stage. */
    probability?: string;
    /** A relation field to the group object (e.g. the stage's pipeline). */
    group?: string;
  };
  /** This object's relation field to the group object (e.g. the deal's pipeline). */
  group?: string;
  /** This object's probability (number or percent) and the boolean flag set when it is overridden. */
  probability?: { field: string; overridden: string };
  /** This object's date field set on entering a won or lost stage, cleared on reopening. */
  closedDate?: string;
  /** This object's select field mirroring the stage type (options open, won, lost). */
  status?: string;
  /** Fields required in every stage of a type, on top of each stage's own required fields. */
  requiredByType?: Partial<Record<StageType, readonly string[]>>;
  /**
   * A text setting of this extension (`settings`) naming the group (by id or title) a record
   * created without a group or stage goes in, e.g. the default pipeline.
   */
  defaultGroupSetting?: string;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null";
export type ViewFilter =
  | { field: string; op: FilterOp; value?: unknown }
  | { and: ViewFilter[] }
  | { or: ViewFilter[] };

/**
 * A saved view shipped with the extension: shared with everyone, read-only, listed in the
 * object's views menu (ADR 0103). A table by default, or a board, calendar or gallery (ADR 0056).
 * Filter values may be relative: `{ $relative: "me" | "today" | "startOfMonth" | … }`.
 */
export interface ViewSpec {
  label: string;
  /** Object the view lists: core or `<extension>.<object>`. */
  object: string;
  type?: "table" | "board" | "calendar" | "gallery";
  filter?: ViewFilter;
  sort?: { field: string; direction?: "asc" | "desc" };
  columns?: string[];
  /** board: the single-select or stage relation to group by, and a number field to sum. */
  groupBy?: string;
  sumField?: string;
  /** calendar */
  dateField?: string;
  mode?: "month" | "week" | "agenda";
  /** gallery */
  imageField?: string;
  /** board, calendar, gallery: fields on each card. */
  cardFields?: string[];
}

/**
 * A view on another object's record page (ADR 0058): a tab, or a side panel, listing records of
 * `view.object` whose `view.relation` field points at the record being shown, e.g. the projects
 * of an organisation. The host renders it with its own components; extensions ship no UI.
 */
export interface RecordViewSpec {
  label: string;
  /** The record page it appears on: `person`, `organisation`, `task` or `<extension>.<object>`. */
  on: string;
  view: {
    type: "table" | "board" | "calendar" | "gallery";
    /** The object listed. */
    object: string;
    /** The field of `object` that holds the current record's id (a relation, or `linkedRecordId`). */
    relation: string;
    filter?: ViewFilter;
    sort?: { field: string; direction?: "asc" | "desc" };
    /** table: fields shown. */
    columns?: string[];
    /** board: the single-select field to group by, and an optional number field to sum. */
    groupBy?: string;
    sumField?: string;
    /** calendar: the date field, and the starting mode. */
    dateField?: string;
    mode?: "month" | "week" | "agenda";
    /** gallery: an image URL field. */
    imageField?: string;
    /** board, calendar, gallery: fields shown on each card. */
    cardFields?: string[];
  };
  /** Order among the page's tabs or panels (lower first). Default 100. */
  order?: number;
}

/** A typed extension setting, edited by admins in Settings → Extensions (ADR 0058). */
export type SettingSpec = {
  label: string;
  description?: string;
  required?: boolean;
  /** A person's to change (ADR 0507): changed by anyone else, it waits for a person. */
  personApproves?: boolean;
} & (
  | { type: "text"; default?: string }
  | { type: "number"; default?: number; min?: number; max?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "select"; options: readonly SelectOption[]; default?: string }
);

// ---------------------------------------------------------------------------------------------
// Host modules, as seen by tools through `ctx`

export interface OpsModule {
  /** Calls an operation (e.g. `organisation.get`) as this extension, through the gate. */
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
}

export interface StorageModule {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

export interface LogModule {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface AiModule {
  /** Model role `summarise`. */
  summarise(text: string, options?: { maxWords?: number }): Promise<string>;
  /** Model role `extract`: fills `fields` (name → description) from text. */
  extract(text: string, fields: Record<string, string>): Promise<Record<string, unknown>>;
  /** Model role `classify`: picks one of `labels`. */
  classify(text: string, labels: string[]): Promise<{ label: string }>;
}

/** A connected gatekeeper (`codemode:<gatekeeper>`), reached through its connections. */
export interface GatekeeperModule {
  /** Connections of this gatekeeper the caller may use, with their bound resources. */
  connections(): Promise<
    {
      id: string;
      title: string;
      resources: { key: string; bindingName: string; tsType: string }[];
    }[]
  >;
  /**
   * Calls a top-level session method of a bound resource. Side effects come back as pending
   * outbound actions (in `pending`) until a person approves them.
   */
  call(
    connectionId: string,
    resource: string,
    method: string,
    ...args: unknown[]
  ): Promise<{ value: unknown; pending: unknown[]; applied: unknown[] }>;
  /** The session's TypeScript declarations. */
  types(connectionId: string, resource: string): Promise<string>;
}

export interface ExtensionContext {
  extension: { id: string; version: string };
  ops: OpsModule;
  storage: StorageModule;
  log: LogModule;
  ai: AiModule;
  /** A gatekeeper declared in permissions.modules, e.g. `ctx.gatekeeper("email-send")`. */
  gatekeeper(name: GatekeeperModuleName): GatekeeperModule;
  /**
   * Sends a routine email this extension declares (ADR 0590): in an automation of a shipped
   * extension only. Declare the "routine-mail" module.
   */
  routineMail: RoutineMailModule;
  /** Who started this tool, from the host (ADR 0436). Absent in automations. */
  caller?: StartedBy;
}

// ---------------------------------------------------------------------------------------------
// Tools (automations are in automation.ts)

export interface ToolSpec<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  /** For a model: what it does, when to use it, side effects. At least 20 characters. */
  description: string;
  input: In;
  output: Out;
  /** Default `write`. */
  risk?: ToolRisk;
  /**
   * Shows the tool as a button on the record page of `object` (ADR 0246). The host calls it with
   * the record's id in the `idInput` field. If the output has `open: { object, id }`, the app
   * opens that record afterwards.
   */
  recordAction?: RecordActionSpec;
  /**
   * Who may call the tool: a non-empty subset of `staff`, `customer`, `public`, or `device` alone
   * (an enrolled device whose device role holds the tool's `permission`, ADR 0781). Left out, staff
   * only. A tool open to `customer` or `public` must have risk `read` or `write`. Called by a
   * customer, the tool runs as that customer: `ctx.ops` reaches only their own records, through
   * `my.list`, `my.get`, `my.create` and `my.update`. Only shipped extensions and an org's own
   * may open a tool; a runtime extension fails `check` (ADR 0402, ADR 0414).
   */
  audiences?: readonly ToolAudience[];
  /**
   * Fields this tool may set on a customer's own records beyond the object's `customer.write`,
   * by object: a cancel tool lists `{ "shop.order": ["status"] }`. Never the customer field and
   * never `id`. The host allows exactly these, for calls made by this tool (ADR 0414).
   */
  customerFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * The permission a staff caller needs, named `<extension id>:<word>` (`ticketing:checkin`), for
   * a role of this extension to hold (`roles`, ADR 0436). Admins and members hold it as they hold
   * any tool (a viewer only when the tool's risk is `read`); a staff account given one of this
   * extension's roles holds it only when the role lists it. Only shipped extensions and an org's
   * own may declare it. A tool open to `device` names the permission a device role holds
   * (`deviceRoles`, ADR 0781), and no staff role, grant or restriction names it.
   *
   * Or a list: any one of them opens the tool (ADR 0600). Bookings' day view is the coach's and
   * the desk's (`["bookings:coach", "bookings:desk"]`): a coach reaches it through the role, held
   * to the role's limits, and a coach granted the desk's permission reaches it through the grant.
   */
  permission?: string | readonly string[];
  /**
   * Only a person may call it (ADR 0512): the assistant, an MCP client, an automation and other
   * extensions' code are refused by the host, as a core operation with `actors: ["human"]` is.
   * For what a person on the staff decides themselves (giving a pass by hand). Staff only: not
   * with `audiences` that open it to customers or the public. It only narrows who may call, so
   * any extension may declare it.
   */
  humanOnly?: boolean;
  /**
   * A person approves it (ADR 0552): a person on the staff calls it as any tool, and anyone else's
   * call (the assistant, an MCP client, an automation) always waits in the approval queue for a
   * person, whatever the approval policy or preset says, and runs when a person approves it. For
   * what an AI may propose but a person decides (cancelling a class). Staff only, and not a read.
   */
  personApproves?: boolean;
  /**
   * A tool naming both a permission one of this extension's roles holds and a grantable one
   * (ADR 0600) says so on purpose: an account given the grant calls it without the role's limits
   * (Bookings' `day`, the desk's any day). Without it, such a tool is refused by the check, so a
   * grantable permission added to a role's own tool never lifts the role's limits by accident.
   */
  grantLiftsRoleLimits?: boolean;
  /**
   * Every staff account may call it, pack roles included (ADR 0652): a cleaner's `rostering.team`,
   * a coach, the door, as well as admins and members. For a tool whose host operation decides
   * who may do what by a rule of its own (Daily checklists' `today` and `tick`: the checklist's
   * own "who may do it"), so no role or grant has to name it. A person's own act (`humanOnly`),
   * for staff only, with no `permission` or `corePermission`. Only shipped extensions and an
   * org's own may declare it.
   */
  anyStaff?: boolean;
  /**
   * A core permission a staff caller needs instead of `records:read` or `records:write` (ADR
   * 0652): one an admin may grant one by one (`checklists:write`). Admins and those granted it
   * call the tool; nobody else does, and no pack role reaches it (a pack role holds no core
   * permission). For staff only, with no `permission`. Only shipped extensions and an org's own
   * may declare it.
   */
  corePermission?: string;
  /**
   * Fields of the input the audit log never keeps (ADR 0626): a note about someone's leave. The
   * call is still audited, with those fields shown as redacted. It only hides more, so any
   * extension may declare it.
   */
  redact?: readonly string[];
  /**
   * Keys of the tool's answer the host never keeps (ADR 0628): a secret shown once, such as a
   * calendar feed's address. Never in the audit log, an approval's stored result or a stored
   * reply an HTTP retry replays. It only hides more, so any extension may declare it.
   */
  redactResult?: readonly string[];
  handler(input: z.output<In>, ctx: ExtensionContext): Promise<z.input<Out>> | z.input<Out>;
}

/**
 * A fixed staff role an extension declares (ADR 0436): a named set of the permissions its tools
 * declare, and the objects of its own whose records the role may read (`record.get` and
 * `record.list`). A human admin gives it to a staff account, which then may do exactly this and
 * nothing else: no other records, no settings, no other operation. The door role of Ticketing:
 * `{ permissions: ["ticketing:checkin"], read: ["ticketing.event", ...] }`. Only shipped
 * extensions and an org's own may declare one.
 */
export interface RoleSpec {
  label: string;
  /** What the role is for, shown to the admin who gives it. */
  description: string;
  /** Permissions of this extension's tools (`<id>:<word>`) the role holds. */
  permissions: readonly string[];
  /** Objects of this extension (`<id>.<object>`) whose records the role may read. */
  read: readonly string[];
  /**
   * Objects whose records the role reaches only when a datetime on them falls on the
   * day it is on (ADR 0553), by object: the moment, and optionally its end and zone, read through
   * one relation at most: `{ "bookings.class": { at: "startsAt", until: "endsAt", zone:
   * "timezone" } }`. A record is today's when its start falls on today's date in its zone (the
   * organisation's when empty), or it has started and not yet ended. The host holds it on every
   * call the account makes and every call of a tool run it started. Other staff are not limited.
   */
  today?: Readonly<Record<string, string | { at: string; until?: string; zone?: string }>>;
  /**
   * Objects whose records the role reaches only for the People its holder looks after (ADR
   * 0889), by object: its relation (one record) to `person`. Its holder looks after a Person
   * when a live record of one of this extension's objects that declares a `team` names them in
   * its staff fields (a client's assignment naming the coach). The host holds it on every call
   * the account makes and every call of a tool run it started: a list holds only those People's
   * records, a read or a change of another's is not found, a new record must be about one of
   * them, and any other operation naming the object is refused. Other staff are not limited.
   */
  looksAfter?: Readonly<Record<string, string>>;
  /**
   * Objects whose records the role reaches only through a live record of this extension naming
   * its holder (ADR 0755), by object: that record's object (`through`), its user field naming the
   * holder (`who`), the relations from it to the object reached (`path`), the states in which it
   * counts (`live`) and a window around its datetimes (`within`). Jobs' crew reaches the jobs on
   * which it has a crew place, from a week before the visit to a week after. The host holds it on
   * every call the account makes and every call of a tool run it started: a list holds only those
   * records, a read or a change of another is not found, and so is a write naming another in a
   * relation, a new record is refused, a change to a field that decides the reach is refused, and
   * so is any other operation. Every field deciding it is `personApproves`. Other staff are not
   * limited.
   */
  mine?: Readonly<Record<string, MineSpec>>;
}

/**
 * A device role an extension declares (ADR 0781): what an enrolled device given it may do, with
 * no person signed in. A human admin enrols a device for the role (`device.enrol { use: "role",
 * role: "<id>.<name>" }`); its credential then calls exactly the tools whose permission the role
 * lists (each open to `device` only) and `device.heartbeat`, and nothing else. It reads no
 * record: its tools return only what their outputs declare. Bookings' check-in tablet:
 * `{ permissions: ["bookings:checkin"], screen: { block: "bookings-checkin-tablet", export:
 * "CheckInTablet" } }`. Only a shipped pack may declare one: a runtime extension's fails `cos ext
 * check` and install, and is ignored at run time.
 */
export interface DeviceRoleSpec {
  label: string;
  /** What the device is for, shown to the admin who enrols it. */
  description: string;
  /** Permissions of this extension's device tools (`<id>:<word>`) the role holds. */
  permissions: readonly string[];
  /** The device's screen: a web block of this pack and the component it exports. */
  screen: { block: string; export: string };
}

/**
 * Who started a tool (ADR 0436), set by the host from the session it verified and never from the
 * input: a staff user, a signed-in customer, the public, or an enrolled device holding one of
 * this extension's device roles (ADR 0781: the device's id and the name an admin gave it, "Front
 * door tablet"). A tool's own operation calls run as the extension (or as the customer, ADR
 * 0414); this is for recording who asked, such as who checked a ticket in, or that a booking was
 * ticked at the door. Absent in automations and in a manifest evaluation.
 */
export type StartedBy =
  | { readonly kind: "staff"; readonly userId: string; readonly name: string }
  | { readonly kind: "customer" }
  | { readonly kind: "public" }
  | { readonly kind: "device"; readonly deviceId: string; readonly name: string };

/**
 * Who may call a tool. `staff` when nothing is declared (ADR 0402). `device` (ADR 0781): an
 * enrolled device whose device role holds the tool's permission, on the desk origin only; a tool
 * open to `device` is open to nobody else.
 */
export const TOOL_AUDIENCES = ["staff", "customer", "public", "device"] as const;
export type ToolAudience = (typeof TOOL_AUDIENCES)[number];

/**
 * One condition of a `public` or `signedIn` declaration's `when` (ADRs 0438 and 0689): a state (a
 * select field) of the record itself, or, with `via`, of the record one of its relations points
 * to; or, `via` alone (in `public` only), that the record it points to is one the public reads
 * (published, if its object is publishable, and meeting its own `when`): a variant while its item
 * is published.
 */
export type PublicCondition =
  | {
      /** A relation of this object, to another object of this extension: test that record. */
      via?: string;
      /** A select field (of this record, or of the one `via` points to). */
      field: string;
      /** The values for which the record is public. */
      in: readonly string[];
    }
  | {
      /** A relation of this object, to another object of this extension that declares `public`. */
      via: string;
      field?: undefined;
      in?: undefined;
    };

/**
 * What the public may read of an object (ADR 0438). `when` is a condition, or a list of up to
 * three that must all hold (ADR 0689): an event while it is `on_sale`; a ticket type while its
 * event is; a variant while it is `active` and its item is published.
 */
export interface PublicSpec {
  read: readonly string[];
  /** Left out, every live record is public (a catalogue item). */
  when?: PublicCondition | readonly PublicCondition[];
}

/**
 * What a customer reads of a record their own record points to (ADR 0439): see
 * `ObjectSpec.customerVia`. `from` is `<extension>.<object>`, as a relation's `to` is.
 */
export interface CustomerViaSpec {
  /** An object of this extension that declares a `customer` (a ticket). */
  from: string;
  /** A relation of `from` to one record of this object (the ticket's `event`). */
  field: string;
  /** Fields of this object its customer may read. */
  read: readonly string[];
}

/** Who holds access to a record: see `ObjectSpec.access` (ADR 0477). */
export interface AccessSpec {
  /** Where access comes from. Any one live source is enough. */
  sources: readonly AccessSourceSpec[];
}

/**
 * One source of access. A record source (`via`) is a record of another of this extension's
 * objects that declares a customer: the caller's own, in one of `states`, before its `until`,
 * pointing at the record through `field` (an enrolment's `course`) or, with `through`, at a
 * record whose field `through` lists it (an enrolment's `bundle`, whose `courses` name the
 * course). A source of another `kind` is one the host provides (a subscription, stage 32).
 */
export type AccessSourceSpec =
  | {
      /** `<extension>.<object>`: an object of this extension that declares a customer. */
      via: string;
      /** A relation of `via` to one record of this object, or of the object `through` is on. */
      field: string;
      /**
       * A field of the record `field` points to that lists this object's records: a many
       * relation, or a document whose refs name them. Read from its published version when the
       * public reads it.
       */
      through?: string;
      /** The states of `via` (its `states` behaviour) in which it gives access. */
      states?: readonly string[];
      /** A date or datetime field of `via`: access ends then. Empty is no end. */
      until?: string;
      kind?: undefined;
    }
  | {
      /**
       * A kind of source the host provides. `subscription` (stage 32a, ADR 0488): the caller
       * holds a running subscription to a plan of `options.plans` (`<extension>.<object>`, an
       * object of this extension whose `sellable` declares `recurring`), and `options.covers`
       * is `"all"`: every live record. Access follows the subscription's holder.
       */
      kind: string;
      options?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
      via?: undefined;
    };

/** What every signed-in customer may read: see `ObjectSpec.signedIn` (ADR 0447). */
export interface SignedInSpec {
  read: readonly string[];
  /** Left out, every live record. */
  when?: PublicSpec["when"];
}

/** Versions of an object's content: see `ObjectSpec.publishable` (ADR 0446). */
export interface PublishableSpec {
  /** The fields a version keeps: the content staff edit in the working copy. */
  content: readonly string[];
  /**
   * The record's address (stage 28, ADR 0442): a `slug` field of the object's own, not in
   * `content`. The public reads a record by it (`content.get`); a published record whose slug
   * changes keeps the old one as a redirect. Left out on an object the public reads, its records
   * are listed only (`content.list`) and `content.get` finds none (ADR 0810). An object with an
   * author (a `customer`) has none.
   */
  slug?: string;
  /**
   * The date a reader is shown (stage 28, ADR 0441): a date or datetime field in `content`. Left
   * empty, publishing fills it with the time it goes live, in the working copy and the version.
   * Set, it is kept: an imported post keeps its date.
   */
  date?: string;
  /**
   * The states in which the record may be published (ADR 0810): values of the object's `states`
   * field. A publish (or a scheduled one coming due) of a record in any other state is refused,
   * and a record that moves out of them is unpublished in the same batch. A review without its
   * author's consent is never published. Left out, any state.
   */
  publishIn?: readonly string[];
  /**
   * Read and understood (stage 38, ADR 0702): the staff who must read a record confirm its
   * current version with one tap, and a person publishing a later version says whether it asks
   * them again (`readAgain`) or is a small fix. `who` names a `document` field of the object's
   * own, outside `content`, with the schema `MUST_READ_SCHEMA`. `manage` names a permission of
   * this extension's tools that is restricted and grantable: who holds it, and admins, read who
   * has confirmed and change who must read a published record. Not on an object the public or a
   * customer reads.
   */
  acknowledge?: { who: string; manage: string };
  /**
   * Staff read (stage 38, ADR 0701): every staff account reads the current published version,
   * never the working copy, through `content.staffGet`, `content.staffList` and `content.search`,
   * pack-role accounts (a coach, a cleaner, the door) included, which read nothing else outside
   * their own pack. What they read is the `content` fields and the slug. Editors still edit the
   * working copy on the record's page.
   */
  staffRead?: boolean;
}

/** An object's customer: see `ObjectSpec.customer`. */
export interface CustomerSpec {
  field: string;
  read: readonly string[];
  write: readonly string[];
  /**
   * Relations whose record the customer must hold access to for any write of theirs (stage 42,
   * ADR 0478): a lesson's progress is written only while its course is theirs. Checked by the host
   * on create and on every update, against the record the row points to.
   */
  requireAccess?: readonly string[];
  /**
   * Fields of `write` a customer sets only when they make the record, never after (ADR 0507): a
   * booking's class and the holder it spends from. Refused on any later write of theirs, through
   * any tool.
   */
  createOnly?: readonly string[];
  /**
   * Whether a customer may put one of their own records in the Trash, through a pack tool's
   * `my.delete` (ADR 0414, amended 2026-11-24): a logged set ticked by mistake. Left out, they
   * cannot. A reviewed change, as `customer` is.
   */
  delete?: boolean;
  /**
   * The family link (ADR 0540): a signed-in guardian also reads their live dependants' records of
   * this object (a child's bookings), with the same `read` fields. With `write: true` they also
   * make records for a dependant (`my.create`'s `forPersonId`) and change the dependant's, with
   * the same `write` fields. `madeBy` names a relation to one person the host sets, on every
   * record a customer makes, to the Person who made it. Staff link guardians to dependants; the
   * seam checks the link in every read and write. A reviewed change, as `customer` is.
   */
  guardians?: { write?: boolean; madeBy?: string };
}

/** A tool shown as a button on a record page. */
export interface RecordActionSpec {
  /** The object whose record pages show the button (`leads.lead`). */
  object: string;
  label: string;
  /** The input field that receives the record id. */
  idInput: string;
  /** A confirmation question shown before running it. */
  confirm?: string;
  /** One choice to ask for first, passed in the `input` field (a disqualify reason). */
  ask?: { input: string; label: string; options: readonly { value: string; label: string }[] };
  /** Hides the button while the record's `field` holds one of `values` (a converted lead). */
  hideWhen?: { field: string; values: readonly string[] };
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  tool: ToolSpec<In, Out>,
): ToolSpec<In, Out> {
  return tool;
}

// ---------------------------------------------------------------------------------------------
// Permissions and the extension

/**
 * What the extension may do, approved like OAuth scopes. Its own objects are always readable and
 * writable. `read`/`write` name objects (`organisation`, `other.object`); `write` implies `read`.
 * `operations` lists further operations by exact name (e.g. `task.create`, `search.global`).
 */
export interface PermissionsSpec {
  read?: string[];
  write?: string[];
  operations?: string[];
  modules?: HostModuleName[];
}

/**
 * A dashboard the extension ships (ADR 0103): the same filters and widgets as a dashboard spec
 * (ADR 0057; SQL over rec_* views with named params, a chart mapping, a click-through). It is
 * read-only, listed while the extension is active and copyable; `home: true` makes it everyone's
 * default Home.
 */
export interface DashboardDeclaration {
  title: string;
  description?: string;
  home?: boolean;
  filters?: readonly Record<string, unknown>[];
  widgets: readonly WidgetDeclaration[];
}

/** A widget of a shipped dashboard; see the host's dashboard spec for every option. */
export interface WidgetDeclaration {
  id: string;
  type: "kpi" | "bar" | "line" | "donut" | "funnel" | "table" | "leaderboard" | "markdown";
  title: string;
  description?: string;
  sql?: string;
  markdown?: string;
  mapping?: Record<string, unknown>;
  options?: Record<string, unknown>;
  clickThrough?: { object: string; objectColumn?: string; filter?: unknown };
  layout?: { w?: number; h?: number };
}

export interface ExtensionSpec {
  /** Lowercase letters and digits, starting with a letter: `deals`, `example`. */
  id: string;
  /** Semver, e.g. `1.0.0`. */
  version: string;
  contractVersion: number;
  label?: string;
  description?: string;
  /**
   * Extensions this one needs installed first, by id (stage 42, ADR 0478): Courses requires
   * Programs. The host refuses to install it while one is missing, and installs shipped ones in
   * that order.
   */
  requires?: readonly string[];
  permissions?: PermissionsSpec;
  objects?: Record<string, ObjectSpec>;
  /** Fields added to other objects, keyed by target object (`organisation`, `other.object`). */
  fields?: Record<string, FieldSpecs>;
  views?: Record<string, ViewSpec>;
  /** Dashboards shipped with the extension (ADR 0103). */
  dashboards?: Record<string, DashboardDeclaration>;
  /** Tabs on other objects' record pages (ADR 0058). */
  recordTabs?: Record<string, RecordViewSpec>;
  /** Side panels on other objects' record pages (ADR 0058). */
  recordPanels?: Record<string, RecordViewSpec>;
  /** Typed settings, edited in Settings → Extensions (ADR 0058). */
  settings?: Record<string, SettingSpec>;
  // biome-ignore lint/suspicious/noExplicitAny: tools of any input/output schema.
  tools?: Record<string, ToolSpec<any, any>>;
  // biome-ignore lint/suspicious/noExplicitAny: automations of any trigger type.
  automations?: Record<string, AutomationSpec<any>>;
  /** Fixed staff roles an admin can give to a staff account (ADR 0436). */
  roles?: Record<string, RoleSpec>;
  /**
   * Device roles an admin can enrol a device for (ADR 0781): the business's own tablet, signed in
   * as nobody, calling only the tools the role holds (`audiences: ["device"]`).
   */
  deviceRoles?: Record<string, DeviceRoleSpec>;
  /**
   * Permissions of this extension's tools (`<id>:<word>`) a human admin may grant to a staff
   * account one by one (ADR 0449), on top of its role: a coach who is a member granted the
   * permission of a tool a member could not otherwise call. Only shipped extensions and an org's
   * own may declare them. An account holding one of the installed packs' roles may be granted
   * them too: what it holds is the role and its grants, added up (ADR 0600). A permission one of
   * this extension's roles holds cannot be grantable (a grant never lifts a role's limits).
   */
  grantable?: readonly string[];
  /**
   * Routine mail (ADR 0590): fixed emails about this extension's records that the host sends
   * without a person's approval, each a kind an admin can turn off. Only shipped extensions may
   * declare it, and only their automations send it (`ctx.routineMail.send`).
   */
  routineMail?: Record<string, RoutineMailSpec>;
  /**
   * Journey signals (stage 53, ADR 0802): moments about a Person that a journey can start or stop
   * on, each a record of this extension's objects created or entering a state, and the field
   * naming its Person (`started: { label: "Membership started", object: "membership" }`). The
   * host records the last time each Person had each one, in the write's own batch. Only shipped
   * extensions may declare them.
   */
  journeySignals?: Record<string, JourneySignalSpec>;
  /**
   * What each grantable permission gives, in plain words, shown to the admin who ticks it
   * (`{ "bookings:desk": "Works the front desk: ..." }`). Absent: the tools it opens are listed.
   */
  grantableLabels?: Readonly<Record<string, string>>;
  /**
   * Permissions of this extension's tools (`<id>:<word>`) that are **restricted** (stage 45, ADR
   * 0625): a tool naming one is held by admins, and by a staff account a human admin granted it
   * (declare it `grantable` too), and by nobody else. Without it, every member holds every tool
   * (a tool's own permission only adds a way in). For pay totals and rostering other people. A
   * tool naming a restricted permission names only restricted ones; no role holds one; it is
   * never called by an automation or another extension's code. Only shipped extensions and an
   * org's own may declare them.
   */
  restricted?: readonly string[];
  /**
   * The roster's rules this extension sets for the host (stage 45, ADR 0626): `rosters`, the
   * restricted permission whose holders roster other people's shifts (with admins: they are the
   * rosterers the host tells and lets roster), and the number settings of this extension the
   * host's rules read (the offer cut-off in minutes, the uncovered window in days). Only a
   * shipped extension or an org's own may declare it.
   */
  staffing?: StaffingRulesSpec;
  /**
   * The staff screens of a shipped pack (stage 47, ADR 0660), by key: each a web block of this
   * pack that the product's admin builds in and shows to whoever could call every tool in its
   * `opens`. Only a shipped pack may declare them: its blocks are code in the repository,
   * reviewed like the rest of it. A runtime extension declaring `screens` fails `cos ext check`
   * and install, and the key is ignored at run time.
   */
  screens?: Record<string, ScreenSpec>;
  /**
   * The numbers a shipped pack adds to the owner's Today (stage 60, ADR 0870), by key: each a
   * read-only query over `rec_*` views that the host runs for the business's local day and shows
   * to whoever could call every tool in its `opens`. Not `today`: that names a pack role's limit
   * (ADR 0553). Only a shipped pack may declare them, at most 8; a runtime extension declaring
   * `todayItems` fails `cos ext check` and install, and the key is ignored at run time.
   */
  todayItems?: Record<string, TodayItemSpec>;
  /**
   * The pack's sections of My account (stage 48, ADR 0710), by key: the customer's own area on
   * the business's website and in its app. Each names a web and a native block of this pack, the
   * objects whose records mean "this customer has some" (`has`), and where it sits. The host lists
   * a section to a customer only when they, or a child linked to them where the object opens to
   * guardians, have one of those records (`me.portal`); `cos add web-account` copies the blocks and
   * writes the wiring. Only a shipped pack may declare sections: a runtime extension declaring
   * `portal` fails `cos ext check` and install, and the key is ignored at run time.
   */
  portal?: Record<string, PortalSectionSpec>;
}

/**
 * One section of My account a shipped pack adds (stage 48, ADR 0710). The client app's shell
 * renders `export` of the block, giving it the pack's hooks under the pack's id (`bookings`,
 * `memberships`) and the page's `returnUrl`: every other prop of the component is optional.
 */
export interface PortalSectionSpec {
  /** The section's heading: "Memberships and passes". */
  label: string;
  /** The website's block: a web block of this pack, and the component it exports. */
  web?: { block: string; export: string };
  /** The app's block: a native block of this pack (`<id>-native-<name>`), and its component. */
  native?: { block: string; export: string };
  /**
   * Where it sits among the sections, lower first: 1 to 59, so a pack's come before the base
   * sections (Orders at 60 onward).
   */
  order: number;
  /**
   * This pack's objects (`<id>.<object>`) that declare a customer, whose records mean the
   * customer has something here: the section shows only then. Never empty: a page anyone may
   * open ("Buy a pass") is a page the client links to, not a section.
   */
  has: readonly string[];
}

/** How a Today item's value is shown. Money is never a pack's: it is the host's (stage 52). */
export const TODAY_ITEM_FORMATS = ["count", "percent"] as const;
export type TodayItemFormat = (typeof TODAY_ITEM_FORMATS)[number];

/** What a Today item's value is compared with: the same time yesterday or a week ago, or nothing. */
export const TODAY_ITEM_COMPARES = ["yesterday", "lastWeek", "none"] as const;
export type TodayItemCompare = (typeof TODAY_ITEM_COMPARES)[number];

/** The parameters the host binds into a Today item's SQL: the local day `[from, to)` and now. */
export const TODAY_ITEM_PARAMS = ["today_from", "today_to", "now"] as const;

/**
 * One number a shipped pack adds to Today (stage 60, ADR 0870). The host binds `:today_from`,
 * `:today_to` (the business's local day, as instants) and `:now`, runs `sql` under the widget
 * rules (one `SELECT` or `WITH` over `rec_*` views, bound parameters, row and time limits) and
 * shows its one column, `value`. For the comparison it binds the earlier day's window instead.
 */
export interface TodayItemSpec {
  /** The card's label: "Came today". */
  label: string;
  /** Where it sits among every item on Today (lower first). Default 100. */
  order?: number;
  /** `count` or `percent`. No money format: a money number is a Finance reports figure. */
  format: TodayItemFormat;
  /** Read-only SQL returning one row with one column, `value`. */
  sql: string;
  /** Default `yesterday`. */
  compare?: TodayItemCompare;
  /** When the card needs attention: its value above or below a number. Left out, never. */
  attention?: { above: number } | { below: number };
  /**
   * The rows behind the number, at most 50: read-only SQL with the same parameters returning a
   * display column (`label`), optionally a secondary line (`detail`) and the id of a record of
   * `record.object` (one of this pack's objects, `person` or `organisation`) in column
   * `record.id`. Names and record ids only: never notes, health answers, pay or leave.
   */
  rows?: {
    sql: string;
    label: string;
    detail?: string;
    record: { object: string; id: string };
  };
  /**
   * This pack's own tools, every one of which the viewer must be able to call to see the item,
   * as a screen's `opens` (ADR 0660). At least one is for staff only.
   */
  opens: readonly string[];
  /** On the web, a card opens this screen of the pack (stage 47) rather than its rows. */
  web?: { screen: string };
}

/**
 * One staff screen of a shipped pack (stage 47, ADR 0660). The admin renders `export` of the web
 * block `block` with the pack's hooks, inside its shell; the host lists the screen for a viewer
 * only when they could call every tool in `opens` (`screens.mine`).
 */
export interface ScreenSpec {
  /** The screen's name in the navigation and on its page: "Front desk". */
  label: string;
  /** A web block of this pack (`packs/<id>/blocks/<block>/`), never a native one. */
  block: string;
  /** The component the block exports that renders the screen: "Desk". */
  export: string;
  /**
   * Where it sits in the admin's navigation: a section headed `group`, in `order`. Left out, the
   * screen is reached only from a record (`record`) or a link.
   */
  nav?: { group: string; order?: number };
  /**
   * The tools that decide who may open the screen: this pack's own, every one of which the viewer
   * must be able to call. Name those that decide (the screen's main read and the write its main
   * action makes), not every tool it calls: the host refuses the rest, and the block shows its own
   * state for that. "Could call these tools" is the gate, not a separate permission. At least one
   * is for staff only (never a customer's or the public's tool as the only gate), unless `writes`
   * gates the screen.
   */
  opens?: readonly string[];
  /**
   * Objects of this pack the screen writes through the host's record operations rather than a
   * tool (a builder saving a course): the viewer must be able to write them (`record.update`), so
   * a viewer or a pack role never gets the screen. Gates beside `opens`; one of the two names
   * something.
   */
  writes?: readonly string[];
  /**
   * A record screen: a tab on this object's record page (one of this pack's objects, `person` or
   * `organisation`), given the record's id as the prop `as`. With `nav` too, it is also listed in
   * the navigation, opened without a record: its block then chooses one itself.
   */
  record?: { object: string; as: string };
}

/** The roster's rules an extension sets for the host (ADR 0626): see `ExtensionSpec.staffing`. */
export interface StaffingRulesSpec {
  /** A restricted permission of this extension's tools: who holds it (and admins) roster. */
  rosters: string;
  /**
   * A restricted, grantable permission of this extension's tools: who holds it (and admins) read
   * who is counted for pay, the pay periods' totals, and lock, reopen and export them (ADR 0627).
   */
  pays?: string;
  /**
   * Settings of this extension the host reads, each `personApproves`; the host's defaults when
   * left out.
   */
  settings?: {
    /** Minutes before a shift starts that offers close (default 60). A number setting. */
    offerCutoffMinutes?: string;
    /** Days ahead a shift with nobody on it is warned about and told (default 14). A number. */
    uncoveredDays?: string;
    /** The pay period: a select of `weekly`, `fortnightly`, `monthly` (ADR 0627). */
    payPeriod?: string;
    /** The local date (YYYY-MM-DD) one weekly or fortnightly period starts: a text setting. */
    payPeriodStart?: string;
    /** The day of the month (1 to 28) a monthly period starts: a number setting. */
    payPeriodDay?: string;
  };
}

const EXTENSION = Symbol.for("ops.extension");

export type Extension<E extends ExtensionSpec = ExtensionSpec> = E & { readonly [EXTENSION]: true };

/** The entry point of every extension: `export default defineExtension({ ... })`. */
export function defineExtension<const E extends ExtensionSpec>(extension: E): Extension<E> {
  return { ...extension, [EXTENSION]: true } as Extension<E>;
}

export function isExtension(value: unknown): value is Extension {
  return typeof value === "object" && value !== null && EXTENSION in value;
}

export type { FieldTypeName };
