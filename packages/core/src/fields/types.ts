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
  /** Extension objects: something that can be bought (stage 27, ADR 0435). */
  sellable?: SellableDefinition;
  /**
   * A fixed state machine (ADR 0425), with registry field names. An object has stages or states,
   * never both.
   */
  states?: StatesDefinition;
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
  }[];
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
