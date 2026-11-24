// The field registry: per-object field definitions used to validate filters and sorts, compile
// them to SQL, and decide which changes are timeline-worthy (ADR 0016, ADR 0017).
//
// Registry entries are trusted code: `column`, `related.from`, `related.link` and
// `related.column` are spliced into SQL as identifiers. They never come from user input, and
// stage-3 extension fields must be generated from validated identifiers.

export type FieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "id"
  | "enum"
  | "json";

/** How a multi-valued field (emails, domains, tags) is reached: an EXISTS subquery. */
export interface RelatedSource {
  /** FROM clause of the subquery, e.g. `core_person_emails r`. */
  from: string;
  /** Expression equal to the parent record's id inside the subquery, e.g. `r.person_id`. */
  link: string;
  /** The value compared by the filter, e.g. `r.email`. */
  column: string;
  /** Extra trusted condition, e.g. `rt.object_type = 'person'`. */
  where?: string;
}

export interface FieldDefinition {
  /** API name, camelCase: the key in operation input/output and in audit diffs. */
  name: string;
  label: string;
  type: FieldType;
  /** Allowed values for `enum` fields. */
  enumValues?: readonly string[];
  /** Column on the object's list source (its rec_* view), for single-valued fields. */
  column?: string;
  /** For multi-valued fields: how to reach the values. */
  related?: RelatedSource;
  filterable: boolean;
  sortable: boolean;
  /** `timeline`: changes to this field post a `system` activity on the record. */
  track?: "timeline";
  /** Extension fields: the extension that declared it (ADR 0023). */
  extension?: string;
  /** Extension fields: the SDK field type (text, currency, formula, …); see field-types.ts. */
  fieldType?: string;
  /** Extension fields: the type's settings (select choices, relation target, currency, …). */
  options?: ExtensionFieldOptions;
  /** Computed (formula) or system-maintained: never written by record operations. */
  readOnly?: boolean;
  required?: boolean;
  description?: string;
}

/** Type-specific settings of an extension field, as validation and the UI need them. */
export interface ExtensionFieldOptions {
  choices?: readonly {
    value: string;
    label: string;
    color?: string;
    /** Fields a record must have a value in to hold this choice (ADR 0058). */
    requires?: string[];
    /** With editableOptions: admins cannot remove it. */
    fixed?: boolean;
  }[];
  /** Admins can edit the choices (ADR 0246); `choices` then holds the edited list. */
  editableOptions?: boolean;
  /** The value a new record gets when none is given (own fields of extension objects). */
  default?: string | number | boolean;
  /** The extension setting that holds the default, when admins choose it. */
  defaultSetting?: string;
  /** A person's to change: other actors' writes wait for a person (ADR 0507). */
  personApproves?: boolean;
  to?: string;
  many?: boolean;
  currency?: string;
  /** Formula source (shown in the UI tooltip) and its result type. */
  expression?: string;
  resultType?: string;
  /** Number, currency and percent fields: the bounds a value is checked against (stage 41). */
  min?: number;
  max?: number;
  step?: number;
  /** Document fields (ADR 0445): the schema its value is checked against, and its size limit. */
  document?: { schema: Record<string, unknown>; maxBytes?: number | undefined };
  /** A declared path of a document field (ADR 0445): the field and the path it reads. */
  documentPath?: { field: string; path: string; count?: boolean | undefined };
}

export interface ObjectDefinition {
  /** Registry name, also the `object_type` in links, tags, audit and search. */
  name: string;
  label: string;
  /** The read view list operations select from. Must have an `id` column. */
  source: string;
  fields: readonly FieldDefinition[];
  /** Default sort for list operations. */
  defaultSort: { field: string; direction: "asc" | "desc" };
  /** Extension objects (ADR 0023): the declaring extension and display metadata. */
  extension?: string;
  plural?: string;
  icon?: string;
  /** Field shown as the record's title. */
  titleField?: string;
  description?: string;
  /** Extension objects: where the UI lists it (ADR 0100). Default `main`. */
  navigation?: "main" | "settings" | "none";
  /** Extension objects: relation fields whose records also get this object's timeline posts. */
  timelineLinks?: readonly string[];
  /** Extension objects: the stage behaviour (ADR 0100), with registry (local) field names. */
  stages?: StagesDefinition;
  /** Extension objects: a limited number of places (stage 26, ADR 0430). */
  capacity?: CapacityDefinition;
  /** Extension objects: goods the host counts, with a ledger (stage 37, ADR 0682). */
  stock?: StockDefinition;
  /** Extension objects: something that can be bought (stage 27, ADR 0435). */
  sellable?: SellableDefinition;
  /** Extension objects: uses held (a pass) or spent (a booking) (stage 32b, ADR 0493). */
  allowance?: AllowanceDefinition;
  /**
   * Extension objects: an agreement point (stage 44, ADR 0641), as declared (it names no field the
   * registry renames; `person` and `enter` are local names, read only from step 3 on).
   */
  /** Extension objects: a health-note list (stage 44, ADR 0643), local field names. */
  healthNotes?: { list: string; person: string };
  agreements?: {
    point: string;
    label: string;
    suggests?: readonly string[];
    enter?: readonly string[];
    person?: string;
    /** The pack's screens show what is due and let a person agree on the way (stage 44 step 5). */
    inlineStep?: boolean;
  };
  /**
   * A fixed state machine (ADR 0425), with registry field names. An object has stages or states,
   * never both.
   */
  states?: StatesDefinition;
  /**
   * Extension objects: a capacity claimant (stage 31, ADR 0501): the record's states hold, take
   * and give back one place on the record `on` points to.
   */
  claims?: ClaimsDefinition;
  /** Extension objects: uniqueness among live records in some states (ADR 0502). */
  unique?: readonly UniqueDefinition[];
  /** Extension objects: a weekly schedule generating records of another object (ADR 0500). */
  recurring?: RecurringDefinition;
  /** Extension objects: a shift, who works it, when and on what (stage 45, ADR 0621). */
  staffed?: StaffedDefinition;
  /** A checklist its person ticks off (stage 45 step 4b, ADR 0650), with registry names. */
  checklists?: ChecklistsDefinition;
  /**
   * The user field that holds the record's owner (ADR 0246): `ownerId` on people and
   * organisations, the declared `owner` of an extension object. Assignment rules set it.
   */
  ownerField?: string;
  /** Extension objects: sidebar position among extension objects (lower first). */
  navigationOrder?: number;
  /** Extension objects: groups of fields of which a record must have at least one. */
  requireOneOf?: readonly (readonly string[])[];
  /** Extension objects: how a record created without a title is named (ADR 0246). */
  titleDefault?: { from: readonly string[]; suffix?: string | undefined };
  /**
   * The object's customer (ADR 0402): the field that says whose record it is and, field by
   * field, what that customer may read and write. Left out, the object does not exist for
   * customers. Enforced only at the visibility seam.
   */
  customer?: CustomerDeclaration;
  /**
   * What the public may read (ADR 0438): fields, of the records meeting a condition on a state.
   * Left out, the object does not exist for the public. Enforced only at the visibility seam.
   */
  public?: PublicDeclaration;
  /**
   * What every signed-in customer may read (ADR 0447): fields, of the records meeting a
   * condition, whoever's they are. Beside `customer` it shares those records; alone it opens
   * them to read. Enforced only at the visibility seam.
   */
  signedIn?: PublicDeclaration;
  /** Versions of the content fields (ADR 0446), with registry field names. */
  publishable?: PublishableDefinition;
  /**
   * What a customer may read of a record one of their own records points to (ADR 0439). Left
   * out, a customer reads nothing of the object that way. Enforced only at the visibility seam.
   */
  customerVia?: CustomerViaDeclaration;
  /**
   * Who holds access to a record (stage 42, ADR 0477): the sources the seam's one question
   * (`holdsAccess`) answers from. A document's `holders` parts are read only by a holder.
   */
  access?: AccessDeclaration;
}

/**
 * What a customer reads of a record their own record points to (ADR 0439): the fields in `read`
 * of the records that a record of `from` (an object that declares a customer) whose customer is
 * the caller points to through its single relation `field`. Names are registry names.
 */
export interface CustomerViaDeclaration {
  readonly from: string;
  readonly field: string;
  readonly read: readonly string[];
}

/** The publishable behaviour as the host enforces it (the SDK's PublishableSpec, validated). */
export interface PublishableDefinition {
  /** The fields a version keeps. */
  readonly content: readonly string[];
  /** The record's address: a slug field of the object's own, not content (ADR 0442). */
  readonly slug?: string;
  /** The date a reader is shown: a date or datetime content field, filled on publish (ADR 0441). */
  readonly date?: string;
}

/**
 * What the public may read of an object (ADR 0438). Names are registry field names. `when`
 * tests a select field of the record or, with `via` (a relation to one record), of the record it
 * points to. Stage 28's `publishable` adds being published as another condition.
 */
export interface PublicDeclaration {
  readonly read: readonly string[];
  /** Left out, every live record is public. */
  readonly when?: {
    readonly via?: string | undefined;
    readonly field: string;
    readonly in: readonly string[];
  };
}

/**
 * Whose record it is, and what that customer may read and write (ADR 0402). Names are registry
 * field names. Fields not listed are invisible to customers.
 */
export interface CustomerDeclaration {
  /** The relation to one person that says whose record it is (`id` on a person). */
  readonly field: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
  /**
   * Relations whose record the customer must hold access to for any write of theirs (stage 42,
   * ADR 0478), asked of the seam's one question (`holdsAccess`).
   */
  readonly requireAccess?: readonly string[] | undefined;
  /** Fields of `write` a customer sets only on create (ADR 0507). */
  readonly createOnly?: readonly string[] | undefined;
  /**
   * The family link (ADR 0540): a customer's scope on this object is their own Person's records
   * or a live dependant's. Left out, a guardian reads nothing of a dependant's here.
   */
  readonly guardians?: GuardiansDeclaration | undefined;
}

/** What a guardian may do with a dependant's records of an object (ADR 0540). */
export interface GuardiansDeclaration {
  /**
   * The guardian also writes them, through the same `customer.write` fields as their own: makes
   * one for a dependant (`for`) and changes the dependant's. Left out or false: read only.
   */
  readonly write?: boolean | undefined;
  /**
   * A relation to one person the host sets, on every record a customer makes, to the Person who
   * made it (the guardian, for a dependant's). Never a customer's or a tool's to set.
   */
  readonly madeBy?: string | undefined;
}

/** One condition of a holder's `spendsOn` (the SDK's AllowanceCondition), validated. */
export interface AllowanceConditionDefinition {
  readonly field: string;
  readonly in?: string | readonly string[] | undefined;
  readonly atLeast?: string | number | undefined;
  readonly below?: string | number | undefined;
}

/**
 * The allowance behaviour as the host enforces it (the SDK's AllowanceSpec, validated), with
 * registry field names (an object's own fields are named as declared) and spenders' objects by
 * registry name. A path is a field of the record or `relation.field`, one relation away.
 */
export type AllowanceDefinition =
  | {
      readonly kind: "holder";
      readonly person: string;
      readonly uses: string;
      readonly per: { readonly fixed: "total" | "week" | "month" } | { readonly field: string };
      readonly spendsOn: readonly {
        readonly object: string;
        readonly when: readonly AllowanceConditionDefinition[];
      }[];
      readonly from?: string | undefined;
      readonly until?: string | undefined;
      /** With states: the states it can be spent in. Null: no states, always. */
      readonly live: readonly string[] | null;
      readonly zone?: string | undefined;
      /** An empty `uses` is unlimited (declared); otherwise it is none. */
      readonly emptyIsUnlimited: boolean;
    }
  | {
      readonly kind: "spender";
      readonly person: string;
      readonly holder: string;
      readonly spendIn: readonly string[];
      readonly returnIn: readonly string[];
      readonly at?: string | undefined;
      readonly copy: Readonly<Record<string, string>>;
      readonly local: {
        readonly weekday?: string | undefined;
        readonly minute?: string | undefined;
        readonly zone?: string | undefined;
      };
      readonly movedFrom?: { readonly field: string; readonly state: string } | undefined;
      /** Holders of other extensions that may pay for it (objects or extension ids). */
      readonly paidBy: readonly string[];
      /** A boolean field: while true, entering a spend state spends nothing (ADR 0506). */
      readonly waived?: string | undefined;
    };

/** The stock behaviour as the host enforces it (the SDK's StockSpec, validated). */
export interface StockDefinition {
  /** The number field holding the reorder level, if any. */
  reorderAt?: string | undefined;
  /** The number field holding how many to order, if any. */
  reorderQty?: string | undefined;
  show: "exact" | "low" | "availability";
  /** `low`'s threshold. */
  lowAt?: number | undefined;
}

/** The capacity behaviour as the host enforces it (the SDK's CapacitySpec, validated). */
export interface CapacityDefinition {
  /** The number field holding the places. Empty: unlimited. */
  places: string;
  /** The relation field to the pool record, and the pool's object. */
  pool?: { field: string; object: string } | undefined;
  show: "exact" | "low" | "availability";
  /** `low`'s threshold. */
  lowAt?: number | undefined;
  releaseOnRefund: boolean;
}

/**
 * The sellable behaviour as the host enforces it (the SDK's SellableSpec, validated), with
 * registry field names and the granted object's registry name.
 */
export interface SellableDefinition {
  /** The number (or currency) field holding the price of one, in the currency's major unit. */
  price: string;
  /** What the price is in, when declared or the price field says; else the deployment's. */
  currency?: string | undefined;
  /** Date or datetime fields: on sale from `from` and until `until`. Either may be left out. */
  saleWindow?: { from?: string | undefined; until?: string | undefined } | undefined;
  /** A number field: the most of one record one order may hold. */
  maxPerOrder?: string | undefined;
  /** The deposit for one and the date the balance is due; offered when both have a value. */
  deposit?: { amount: string; balanceDue: string } | undefined;
  /** What a paid line grants: one record of `object` per unit, made by the host. */
  grants?: GrantDefinition | undefined;
  /** Tax at checkout (ADR 0479): the provider's product tax code, and an event's place. */
  tax?: TaxDefinition | undefined;
  /** A plan paid for every period (ADR 0485): subscribed to, never put on an order. */
  recurring?:
    | {
        interval: "week" | "month" | "year";
        /** A number field: the days of a free first period. */
        trialDays?: string | undefined;
        /** What a subscription to it grants, kept in step with it (ADR 0510). */
        grants?: RecurringGrantDefinition | undefined;
        /** Staff may pause one, within these number fields' days (ADR 0531). */
        pause?: { minDays?: string | undefined; maxDays?: string | undefined } | undefined;
      }
    | undefined;
  /** A boolean field: while true, a Person buys the record once across the object (ADR 0512). */
  onePerPerson?: string | undefined;
  /** A paid line moves the record it was started for (ADR 0560): the SDK's MovesSpec. */
  moves?: MovesDefinition | undefined;
}

/** What an order does to the record it was started for (ADR 0560), with registry names. */
export interface MovesDefinition {
  held: string;
  paid: string;
  expired: string;
  refund: readonly string[];
  /** A number path (up to two relations) and the extension's setting when it is empty. */
  price?: { field?: string | undefined; setting?: string | undefined } | undefined;
  /** A text path: the order line's title. */
  title?: string | undefined;
  /** A read-only text field: the order's id. */
  order?: string | undefined;
  /** A guest's record is held with no Person until its order is paid (ADR 0560). */
  guest?: boolean | undefined;
  /** The extension's number setting: the percent of the claimed record's places guests may hold. */
  holdCap?: { setting: string } | undefined;
}

/** The SDK's RecurringGrantSpec with the granted object's registry name (ADR 0510). */
export interface RecurringGrantDefinition {
  object: string;
  set: Readonly<Record<string, string>>;
  from?: string | undefined;
  until?: string | undefined;
  states: Readonly<
    Record<"trialing" | "active" | "past_due" | "unpaid" | "paused" | "ended", string>
  >;
}

/** The SDK's TaxSpec with registry field names. */
export interface TaxDefinition {
  code: string;
  place?:
    | {
        /** A relation of the sellable object; the address fields are on the record it names. */
        via?: string | undefined;
        country: string;
        region?: string | undefined;
        postcode?: string | undefined;
        city?: string | undefined;
        line1?: string | undefined;
      }
    | undefined;
}

/** Where a granted record's field gets its value (the SDK's GrantSource). */
export type GrantSource = string;

export interface GrantDefinition {
  /** The granted object's registry name (`<extension>.<object>`). */
  object: string;
  /** Registry field name of the granted object → where its value comes from. */
  set: Readonly<Record<string, GrantSource>>;
  /** The state what was granted moves to when the order is refunded in full or cancelled. */
  void: string;
  /** The granted object's from and until fields the host writes, and its days (ADR 0511). */
  valid?:
    | { from?: string | undefined; until?: string | undefined; days?: string | undefined }
    | undefined;
}

/** A stage behaviour as the host enforces it (the SDK's StagesSpec, validated). */
export interface StagesDefinition {
  field: string;
  stage: {
    type: string;
    order: string;
    requiredFields?: string | undefined;
    probability?: string | undefined;
    group?: string | undefined;
  };
  group?: string | undefined;
  probability?: { field: string; overridden: string } | undefined;
  closedDate?: string | undefined;
  status?: string | undefined;
  requiredByType?: Partial<Record<"open" | "won" | "lost", readonly string[]>> | undefined;
  defaultGroupSetting?: string | undefined;
}

/** A state machine as the host enforces it (the SDK's StatesSpec, validated). */
export interface StatesDefinition {
  /** The select field holding the state. */
  field: string;
  initial: string;
  moves: readonly {
    from: string | readonly string[];
    to: string;
    by: readonly ("staff" | "customer" | "host")[];
    requires?: readonly string[] | undefined;
    final?: boolean | undefined;
    window?: WindowDefinition | undefined;
    staffOnly?: string | readonly string[] | undefined;
    /** This extension's tools that may also make it, for the person who called them (ADR 0513). */
    tools?: readonly string[] | undefined;
    /** Its window binds staff too (ADR 0507). */
    bindsStaff?: boolean | undefined;
  }[];
  /** Rules on every create (ADR 0503). */
  create?:
    | {
        in?: Readonly<Record<string, readonly ("staff" | "customer" | "host")[]>> | undefined;
        window?: WindowDefinition | undefined;
        staffOnly?: string | readonly string[] | undefined;
        /** While any is true nobody but the host creates one (ADR 0507). */
        closed?: string | readonly string[] | undefined;
      }
    | undefined;
  /** Moves asked for by name, resolved by the host (ADR 0503). */
  requests?: Readonly<Record<string, readonly string[]>> | undefined;
  /** A cascade from the record a relation points to (ADR 0507). */
  follows?:
    | {
        relation: string;
        when: Readonly<Record<string, string>>;
        from: readonly string[];
      }
    | undefined;
  /** Moves the host makes once a moment has passed (ADR 0550). */
  after?:
    | readonly {
        from: string | readonly string[];
        to: string;
        at: string;
        minutesAfter?: number | undefined;
        ifAnyIn?: readonly string[] | undefined;
      }[]
    | undefined;
}

/** A number a window is worked out from (the SDK's WindowNumber, ADR 0505). */
export type WindowNumberDefinition =
  | number
  | string
  | { field?: string | undefined; setting?: string | undefined };

/** One end of a window (the SDK's WindowBound): field paths, numbers in days and minutes. */
export type WindowBoundDefinition =
  | string
  | {
      at: string;
      daysBefore?: WindowNumberDefinition | undefined;
      minutesBefore?: WindowNumberDefinition | undefined;
      zone?: string | undefined;
    };

/** When a customer may make a move or a create (the SDK's MoveWindow). */
export interface WindowDefinition {
  from?: WindowBoundDefinition | undefined;
  until?: WindowBoundDefinition | undefined;
}

/** The SDK's ClaimsSpec with the registry names of the relation and the object it points to. */
export interface ClaimsDefinition {
  /** The relation field (one record) to the record whose places are claimed. */
  on: string;
  /** That record's object, which declares a capacity. */
  object: string;
  held: readonly string[];
  confirmed: readonly string[];
  /** A waitlist on the claimed record's places (ADR 0520). */
  waitlist?: WaitlistDefinition | undefined;
}

/** The SDK's WaitlistSpec, with registry field names. */
export interface WaitlistDefinition {
  state: string;
  promote: string;
  until: WindowBoundDefinition;
  promotedAt?: string | undefined;
  passedOverAt?: string | undefined;
  passedOverReason?: string | undefined;
}

/** The SDK's UniqueSpec: fields and states by name. */
export interface UniqueDefinition {
  fields: readonly string[];
  states?: readonly string[] | undefined;
}

/**
 * The SDK's StaffedSpec (ADR 0621) with registry names: fields are the object's own (local names
 * are registry names), and `who.object` is the registry name of the record holding the account
 * when the person is a relation (a class's coach profile).
 */
export interface StaffedDefinition {
  who: { field: string; account?: string | undefined; object?: string | undefined };
  starts: string;
  ends: string;
  zone?: string | undefined;
  kind: string;
  live: readonly string[];
  place?: string | undefined;
  pattern?: { link: string; who: string } | undefined;
  payBefore?: { field: string } | undefined;
  payAfter?: { field: string } | undefined;
  /** What shows a shift was worked (ADR 0627): `object` is the evidence object's registry name. */
  evidence?: { object: string; link: string; by: string } | undefined;
}

/**
 * The SDK's ChecklistsSpec (ADR 0650): `template` is the checklist field, on this object or (with
 * `via`, a relation field of this object) on `viaObject`, the registry name of what it names.
 */
export interface ChecklistsDefinition {
  template: { field: string; via?: string | undefined; viaObject?: string | undefined };
  who: string;
  opens: string;
  closes: string;
  live: readonly string[];
}

/** The SDK's RecurringScheduleSpec with the objects' registry names (ADR 0500). */
export interface RecurringDefinition {
  /** The generated object's registry name. */
  generates: string;
  link: string;
  rule: {
    weekdays: string;
    time: string;
    length?: string | undefined;
    from: string;
    until?: string | undefined;
    zone?: string | undefined;
  };
  into: {
    starts: string;
    ends?: string | undefined;
    zone?: string | undefined;
    changed?: string | undefined;
  };
  copy: Readonly<Record<string, string>>;
  cancel: string;
  ended?: { field: string; in: readonly string[] } | undefined;
  /** The closure object's registry name and its date fields. */
  closures?: { object: string; from: string; until: string } | undefined;
  horizonDays: number;
  /** The horizon is never less than the largest value of this object's number field (days). */
  horizonAtLeast?: { object: string; field: string } | undefined;
  /** The extension's number setting (days) that sets the horizon when it holds a value (ADR 0626). */
  horizonSetting?: { extension: string; name: string } | undefined;
}

export function defineObject<const O extends ObjectDefinition>(object: O): O {
  const names = new Set<string>();
  for (const field of object.fields) {
    if (names.has(field.name)) throw new Error(`${object.name}: duplicate field ${field.name}`);
    names.add(field.name);
    if ((field.filterable || field.sortable) && !field.column && !field.related) {
      throw new Error(`${object.name}.${field.name}: filterable fields need a column or related`);
    }
    if (field.sortable && !field.column) {
      throw new Error(`${object.name}.${field.name}: only single-valued fields can be sortable`);
    }
    if (field.type === "enum" && !field.enumValues?.length) {
      throw new Error(`${object.name}.${field.name}: enum fields need enumValues`);
    }
  }
  if (!names.has(object.defaultSort.field)) {
    throw new Error(`${object.name}: default sort field ${object.defaultSort.field} is unknown`);
  }
  return object;
}

export function getField(object: ObjectDefinition, name: string): FieldDefinition | undefined {
  return object.fields.find((field) => field.name === name);
}

/** Names of the fields flagged `track: "timeline"`. */
export function timelineFields(object: ObjectDefinition): string[] {
  return object.fields.filter((field) => field.track === "timeline").map((field) => field.name);
}

// Access (stage 42, ADR 0477): its rules are visibility/access.ts's.
/** A source of kind `record`: the caller's own record of `via` (see the header). */
export interface RecordAccessSource {
  readonly kind?: "record" | undefined;
  readonly via: string;
  readonly field: string;
  readonly through?: string | undefined;
  readonly states?: readonly string[] | undefined;
  readonly until?: string | undefined;
}

/** A source of a kind the host provides (`registerAccessSource`). */
export interface KindAccessSource {
  readonly kind: string;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
  readonly via?: undefined;
}

export type AccessSource = RecordAccessSource | KindAccessSource;

/** Who holds access to an object's records (ADR 0477), as declared. */
export interface AccessDeclaration {
  readonly sources: readonly AccessSource[];
}
