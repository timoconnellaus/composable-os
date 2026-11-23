// The extension manifest: the JSON form of an extension (no handlers, tool schemas as JSON
// Schema). The host evaluates an extension in the sandbox to get its manifest, then validates,
// diffs and reconciles the manifest. `validateManifest` is the contract check `extension.check`
// runs; it returns structured issues a model can act on.
import { z } from "zod";
import {
  agreementsManifestSchema,
  checkObjectAgreements,
  checkObjectHealthNotes,
  healthNotesManifestSchema,
} from "./agreements.ts";
import { allowanceManifestSchema, checkObjectAllowance } from "./allowance.ts";
import { automationManifestSchema } from "./automation.ts";
import { checkAutomation } from "./automation-check.ts";
import { checkObjectBehaviour } from "./behaviour.ts";
import {
  capacityManifestSchema,
  checkObjectCapacity,
  checkObjectClaims,
  claimsManifestSchema,
} from "./capacity.ts";
import {
  type Extension,
  HOST_MODULES,
  type HostModuleName,
  STAGE_TYPES,
  SUPPORTED_CONTRACT_VERSIONS,
  TOOL_AUDIENCES,
  TOOL_RISKS,
} from "./contract.ts";
import {
  checkDocumentSchema,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_PATHS,
  type DocumentSchema,
  documentPathNode,
} from "./document.ts";
import { FIELD_TYPES, type FieldTypeName, formulaTypeOf } from "./field-types.ts";
import { checkFormula, type FormulaFieldRef } from "./formula/compile.ts";
import { checkObjectRecurring, recurringManifestSchema } from "./recurring.ts";
import { renamedMessage } from "./renamed.ts";
import { checkObjectSellable, sellableManifestSchema } from "./sellable.ts";
import { checkObjectStaffed, staffedManifestSchema } from "./staffed.ts";
import { checkObjectStates, resolveFieldPath, statesManifestSchema } from "./states.ts";
import { checkObjectUnique, uniqueManifestSchema } from "./unique.ts";

export const EXTENSION_ID_RE = /^[a-z][a-z0-9]{1,29}$/;
export const OBJECT_NAME_RE = /^[a-z][a-z0-9]{0,29}$/;
export const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const TOOL_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPERATION_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Core objects extension fields can target, and which extension objects may not be named. */
export const CORE_OBJECT_NAMES = ["person", "organisation", "activity", "task"] as const;
const RESERVED_OBJECT_NAMES = new Set([
  ...CORE_OBJECT_NAMES,
  "affiliation",
  "user",
  "users",
  "tag",
  "tags",
  "view",
  "audit",
  "record",
]);
const RESERVED_EXTENSION_IDS = new Set([
  "core",
  "ops",
  "rec",
  "x",
  "sdk",
  "system",
  "record",
  "extension",
]);
/** Field names every record already has. */
export const RESERVED_FIELD_NAMES = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "createdBy",
  "deletedBy",
  "tags",
]);
/** Operation prefixes no extension may be granted. */
export const FORBIDDEN_OPERATION_PREFIXES = ["extension.", "policy.", "user.", "audit."] as const;
const TEXT_LIKE: FieldTypeName[] = ["text", "email", "phone", "url", "select"];
/** Objects relations may point at. */
export const RELATION_CORE_TARGETS = ["person", "organisation", "task"] as const;

const optionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
  requires: z.array(z.string().max(80)).max(20).optional(),
  fixed: z.boolean().optional(),
});

export const fieldManifestSchema = z.object({
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  track: z.literal("timeline").optional(),
  renamedFrom: z.string().max(40).optional(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  options: z.array(optionSchema).max(200).optional(),
  editableOptions: z.boolean().optional(),
  default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  defaultSetting: z.string().max(40).optional(),
  personApproves: z.boolean().optional(),
  to: z.string().max(80).optional(),
  many: z.boolean().optional(),
  expression: z.string().max(2000).optional(),
  // Number fields' bounds (stage 41).
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  // Document fields (ADR 0445): the schema is checked by checkDocumentSchema, with its paths.
  schema: z.record(z.string(), z.unknown()).optional(),
  maxBytes: z.number().int().optional(),
  paths: z
    .record(
      z.string().max(40),
      z
        .object({
          label: z.string().min(1).max(100),
          path: z.string().min(1).max(200),
          count: z.boolean().optional(),
          description: z.string().max(1000).optional(),
        })
        .strict(),
    )
    .optional(),
});
export type FieldManifest = z.infer<typeof fieldManifestSchema>;

/** Whether `value` is a whole number of `step`s from `from` (with room for binary fractions). */
export function onStep(value: number, from: number, step: number): boolean {
  const steps = (value - from) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** Field names a publishable object's records get from the host (ADR 0446). */
export const PUBLISHED_FIELD_NAMES = [
  "publishedVersion",
  "publishedAt",
  // Stage 28 (ADR 0441): where the record is (draft, scheduled, published, unpublished) and
  // when a scheduled publish goes live.
  "publishState",
  "publishAt",
] as const;

const readDeclarationSchema = z
  .object({
    read: z.array(z.string().max(40)).min(1).max(100),
    when: z
      .object({
        via: z.string().max(40).optional(),
        field: z.string().max(40),
        in: z.array(z.string().max(100)).min(1).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export const stagesManifestSchema = z.object({
  field: z.string().max(40),
  stage: z.object({
    type: z.string().max(40),
    order: z.string().max(40),
    requiredFields: z.string().max(40).optional(),
    probability: z.string().max(40).optional(),
    group: z.string().max(40).optional(),
  }),
  group: z.string().max(40).optional(),
  probability: z.object({ field: z.string().max(40), overridden: z.string().max(40) }).optional(),
  closedDate: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  defaultGroupSetting: z.string().max(40).optional(),
  requiredByType: z
    .partialRecord(z.enum(STAGE_TYPES), z.array(z.string().max(40)).max(50))
    .optional(),
});
export type StagesManifest = z.infer<typeof stagesManifestSchema>;

export const objectManifestSchema = z.object({
  label: z.string().min(1).max(100),
  plural: z.string().min(1).max(100),
  icon: z.string().max(60).optional(),
  titleField: z.string().max(40),
  description: z.string().max(1000).optional(),
  renamedFrom: z.string().max(40).optional(),
  fields: z.record(z.string(), fieldManifestSchema),
  navigation: z.enum(["main", "settings", "none"]).optional(),
  indexes: z
    .array(z.array(z.string().max(40)).min(1).max(4))
    .max(16)
    .optional(),
  timelineLinks: z.array(z.string().max(40)).max(8).optional(),
  stages: stagesManifestSchema.optional(),
  capacity: capacityManifestSchema.optional(),
  sellable: sellableManifestSchema.optional(),
  allowance: allowanceManifestSchema.optional(),
  agreements: agreementsManifestSchema.optional(),
  healthNotes: healthNotesManifestSchema.optional(),
  states: statesManifestSchema.optional(),
  claims: claimsManifestSchema.optional(),
  unique: uniqueManifestSchema.optional(),
  recurring: recurringManifestSchema.optional(),
  staffed: staffedManifestSchema.optional(),
  owner: z.string().max(40).optional(),
  customer: z
    .object({
      field: z.string().max(40),
      read: z.array(z.string().max(40)).max(100),
      write: z.array(z.string().max(40)).max(100),
      requireAccess: z.array(z.string().max(40)).max(10).optional(),
      createOnly: z.array(z.string().max(40)).max(100).optional(),
      guardians: z
        .object({ write: z.boolean().optional(), madeBy: z.string().max(40).optional() })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  public: readDeclarationSchema.optional(),
  signedIn: readDeclarationSchema.optional(),
  customerVia: z
    .object({
      from: z.string().max(81),
      field: z.string().max(40),
      read: z.array(z.string().max(40)).min(1).max(100),
    })
    .strict()
    .optional(),
  access: z
    .object({
      sources: z
        .array(
          z.union([
            z
              .object({
                via: z.string().max(81),
                field: z.string().max(40),
                through: z.string().max(40).optional(),
                states: z.array(z.string().max(60)).min(1).max(20).optional(),
                until: z.string().max(40).optional(),
              })
              .strict(),
            z
              .object({
                kind: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
                options: z
                  .record(
                    z.string().max(40),
                    z.union([
                      z.string().max(200),
                      z.number(),
                      z.boolean(),
                      z.array(z.string().max(200)).max(20),
                    ]),
                  )
                  .optional(),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(8),
    })
    .strict()
    .optional(),
  publishable: z
    .object({
      content: z.array(z.string().max(40)).min(1).max(40),
      slug: z.string().max(40).optional(),
      date: z.string().max(40).optional(),
    })
    .strict()
    .optional(),
  navigationOrder: z.number().int().min(0).max(10_000).optional(),
  requireOneOf: z
    .array(z.array(z.string().max(40)).min(2).max(8))
    .max(8)
    .optional(),
  titleDefault: z
    .object({
      from: z.array(z.string().max(40)).min(1).max(8),
      suffix: z.string().max(40).optional(),
    })
    .optional(),
  seed: z
    .record(z.string().max(40), z.record(z.string().max(40), z.unknown()))
    .refine((seed) => Object.keys(seed).length <= 200, "At most 200 seed records per object")
    .optional(),
});
export type ObjectManifest = z.infer<typeof objectManifestSchema>;

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const recordActionManifestSchema = z.object({
  object: z.string().min(1).max(80),
  label: z.string().min(1).max(60),
  idInput: z.string().min(1).max(40),
  confirm: z.string().max(300).optional(),
  ask: z
    .object({
      input: z.string().min(1).max(40),
      label: z.string().min(1).max(60),
      options: z
        .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(100) }))
        .min(1)
        .max(50),
    })
    .optional(),
  hideWhen: z
    .object({
      field: z.string().min(1).max(80),
      values: z.array(z.string().min(1).max(100)).min(1).max(50),
    })
    .optional(),
});
export type RecordActionManifest = z.infer<typeof recordActionManifestSchema>;

export const toolManifestSchema = z.object({
  description: z.string().min(20).max(2000),
  risk: z.enum(TOOL_RISKS),
  recordAction: recordActionManifestSchema.optional(),
  audiences: z.array(z.enum(TOOL_AUDIENCES)).min(1).max(3).optional(),
  customerFields: z.record(z.string().max(80), z.array(z.string().max(40)).max(50)).optional(),
  /** The permission a staff caller needs (`<id>:<word>`), for the extension's roles (ADR 0436). */
  permission: z.union([z.string().max(80), z.array(z.string().max(80)).min(1).max(5)]).optional(),
  /** Only a person may call it (ADR 0512). */
  humanOnly: z.literal(true).optional(),
  /** A person approves anyone else's call (ADR 0552). */
  personApproves: z.literal(true).optional(),
  /** The grant opens it without the role's limits, on purpose (ADR 0600). */
  grantLiftsRoleLimits: z.literal(true).optional(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;

/** A fixed staff role (ADR 0436): see `RoleSpec`. */
export const roleManifestSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().min(10).max(500),
  permissions: z.array(z.string().max(80)).max(20).default([]),
  read: z.array(z.string().max(80)).max(20).default([]),
  /** Objects whose records the role reaches only on the organisation's local today (ADR 0553). */
  today: z
    .record(
      z.string().max(80),
      z.union([
        z.string().max(122),
        z
          .object({
            at: z.string().max(122),
            until: z.string().max(122).optional(),
            zone: z.string().max(122).optional(),
          })
          .strict(),
      ]),
    )
    .optional(),
});
export type RoleManifest = z.infer<typeof roleManifestSchema>;

/** A role's or a tool's permission: `<extension id>:<word>`. */
export const EXTENSION_PERMISSION_RE = /^([a-z][a-z0-9]{1,29}):([a-z][a-zA-Z0-9]{0,39})$/;

/** A tool's permissions, one or several (any one opens it, ADR 0600); none when it declares none. */
export function toolPermissions(tool: {
  permission?: string | readonly string[] | undefined;
}): string[] {
  const p = tool.permission;
  return p === undefined ? [] : typeof p === "string" ? [p] : [...p];
}

export const viewManifestSchema = z.object({
  label: z.string().min(1).max(100),
  object: z.string().max(80),
  /** The view type (ADR 0056). Default table. */
  type: z.enum(["table", "board", "calendar", "gallery"]).optional(),
  filter: z.unknown().optional(),
  sort: z
    .object({ field: z.string().max(64), direction: z.enum(["asc", "desc"]).default("asc") })
    .optional(),
  columns: z.array(z.string().max(80)).max(100).optional(),
  groupBy: z.string().max(80).optional(),
  sumField: z.string().max(80).optional(),
  dateField: z.string().max(80).optional(),
  mode: z.enum(["month", "week", "agenda"]).optional(),
  imageField: z.string().max(80).optional(),
  cardFields: z.array(z.string().max(80)).max(8).optional(),
});
export type ViewManifest = z.infer<typeof viewManifestSchema>;

const RECORD_VIEW_TYPES = ["table", "board", "calendar", "gallery"] as const;

export const recordViewManifestSchema = z.object({
  label: z.string().min(1).max(100),
  on: z.string().min(1).max(80),
  view: z.object({
    type: z.enum(RECORD_VIEW_TYPES),
    object: z.string().min(1).max(80),
    relation: z.string().min(1).max(80),
    filter: z.unknown().optional(),
    sort: z
      .object({ field: z.string().max(64), direction: z.enum(["asc", "desc"]).default("asc") })
      .optional(),
    columns: z.array(z.string().max(80)).max(100).optional(),
    groupBy: z.string().max(80).optional(),
    sumField: z.string().max(80).optional(),
    dateField: z.string().max(80).optional(),
    mode: z.enum(["month", "week", "agenda"]).optional(),
    imageField: z.string().max(80).optional(),
    cardFields: z.array(z.string().max(80)).max(8).optional(),
  }),
  order: z.number().int().min(0).max(10_000).default(100),
});
export type RecordViewManifest = z.infer<typeof recordViewManifestSchema>;

/**
 * A dashboard an extension ships (stage 4b): read-only for everyone, listed beside the CRM's own
 * Overview while the extension is active, copyable. `home` makes it the default Home. The host
 * validates `filters` and `widgets` against its dashboard spec (ADR 0057) at check time.
 */
export const dashboardManifestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  home: z.boolean().optional(),
  filters: z.array(z.record(z.string(), z.unknown())).max(8).default([]),
  widgets: z.array(z.record(z.string(), z.unknown())).min(1).max(30),
});
export type DashboardManifest = z.infer<typeof dashboardManifestSchema>;

export const settingManifestSchema = z.object({
  type: z.enum(["text", "number", "boolean", "select"]),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(optionSchema).max(200).optional(),
  personApproves: z.boolean().optional(),
});
export type SettingManifest = z.infer<typeof settingManifestSchema>;

export const permissionsManifestSchema = z.object({
  read: z.array(z.string().max(80)).max(100).default([]),
  write: z.array(z.string().max(80)).max(100).default([]),
  operations: z.array(z.string().max(100)).max(200).default([]),
  modules: z
    .array(
      z.enum(HOST_MODULES, {
        // A manifest written against the old contract is told the module's new name.
        error: (issue) =>
          (typeof issue.input === "string" ? renamedMessage(issue.input) : null) ??
          `Unknown host module; one of ${HOST_MODULES.join(", ")}`,
      }),
    )
    .max(HOST_MODULES.length)
    .default([]),
});
export type PermissionsManifest = z.infer<typeof permissionsManifestSchema>;

export const manifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  contractVersion: z.number().int(),
  label: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  requires: z
    .array(z.string().regex(/^[a-z][a-z0-9]*$/))
    .max(10)
    .optional(),
  permissions: permissionsManifestSchema.default({
    read: [],
    write: [],
    operations: [],
    modules: [],
  }),
  objects: z.record(z.string(), objectManifestSchema).default({}),
  fields: z.record(z.string(), z.record(z.string(), fieldManifestSchema)).default({}),
  views: z.record(z.string(), viewManifestSchema).default({}),
  recordTabs: z.record(z.string(), recordViewManifestSchema).default({}),
  recordPanels: z.record(z.string(), recordViewManifestSchema).default({}),
  settings: z.record(z.string(), settingManifestSchema).default({}),
  dashboards: z.record(z.string(), dashboardManifestSchema).default({}),
  tools: z.record(z.string(), toolManifestSchema).default({}),
  automations: z.record(z.string(), automationManifestSchema).default({}),
  roles: z.record(z.string(), roleManifestSchema).default({}),
  /** Tool permissions an admin may grant one by one (ADR 0449). */
  grantable: z.array(z.string().max(80)).max(20).optional(),
  /** What each grantable permission gives, in plain words, for the admin (ADR 0600). */
  grantableLabels: z.record(z.string().max(80), z.string().min(10).max(300)).optional(),
});
export type ExtensionManifest = z.infer<typeof manifestSchema>;

/**
 * A document field's schema, size and paths (ADR 0445); and that no other type carries them.
 * `fields` are the other fields the same extension declares on the object, which a path's name
 * may not repeat.
 */
function checkDocumentField(
  path: string,
  name: string,
  field: FieldManifest,
  fields: Record<string, FieldManifest>,
  known: ReadonlySet<string>,
  contract: (path: string, message: string) => void,
): void {
  if (field.type === "image" || field.type === "video") {
    for (const key of ["schema", "maxBytes", "paths"] as const) {
      if (field[key] !== undefined) {
        contract(
          `${path}.${key}`,
          `An ${field.type} field has the platform's schema and no ${key}`,
        );
      }
    }
    if (field.track) contract(`${path}.track`, `An ${field.type} is not tracked on the timeline`);
    return;
  }
  if (field.type === "richText") {
    // One fixed schema (ADR 0440): a field declares at most its size.
    for (const key of ["schema", "paths"] as const) {
      if (field[key] !== undefined) {
        contract(`${path}.${key}`, `A richText field has the platform's schema and no ${key}`);
      }
    }
    if (field.track) contract(`${path}.track`, "Rich text is not tracked on the timeline");
    if (
      field.maxBytes !== undefined &&
      (field.maxBytes < 1024 || field.maxBytes > DOCUMENT_MAX_BYTES)
    ) {
      contract(`${path}.maxBytes`, `maxBytes is from 1024 to ${DOCUMENT_MAX_BYTES}`);
    }
    return;
  }
  if (field.type !== "document") {
    for (const key of ["schema", "maxBytes", "paths"] as const) {
      if (field[key] !== undefined) {
        contract(`${path}.${key}`, `Only document and richText fields take ${key}`);
      }
    }
    return;
  }
  if (field.track) contract(`${path}.track`, "A document is not tracked on the timeline");
  if (!field.schema) {
    contract(`${path}.schema`, "A document field declares its schema");
    return;
  }
  // A document's refs may also name the media library (stage 42, ADR 0475): a lesson's video.
  const problems = checkDocumentSchema(field.schema, new Set([...known, "media"]));
  for (const [at, message] of problems) contract(`${path}.schema${at ? `.${at}` : ""}`, message);
  if (
    field.maxBytes !== undefined &&
    (field.maxBytes < 1024 || field.maxBytes > DOCUMENT_MAX_BYTES)
  ) {
    contract(`${path}.maxBytes`, `maxBytes is from 1024 to ${DOCUMENT_MAX_BYTES}`);
  }
  const paths = Object.entries(field.paths ?? {});
  if (paths.length > DOCUMENT_MAX_PATHS) {
    contract(`${path}.paths`, `A document declares at most ${DOCUMENT_MAX_PATHS} paths`);
  }
  for (const [pathName, spec] of paths) {
    const at = `${path}.paths.${pathName}`;
    if (!FIELD_NAME_RE.test(pathName) || RESERVED_FIELD_NAMES.has(pathName)) {
      contract(at, `A path's name is a camelCase field name that is not reserved`);
    }
    if (Object.hasOwn(fields, pathName)) {
      contract(at, `"${pathName}" is already a field: a path's name is a column of its own`);
    }
    const others = Object.entries(fields).filter(
      ([other, f]) => other !== name && f.type === "document" && f.paths && pathName in f.paths,
    );
    if (others.length) contract(at, `"${pathName}" is a path of ${others[0]?.[0]} too`);
    if (!problems.length) {
      const reached = documentPathNode(field.schema as unknown as DocumentSchema, spec);
      if (typeof reached === "string") contract(`${at}.path`, reached);
    }
  }
}

/** One problem `check` found. `path` points into the manifest, e.g. `objects.project.fields.x`. */
export interface ManifestIssue {
  code:
    | "contract"
    | "formula_syntax"
    | "formula_type"
    | "formula_unknown_field"
    | "formula_unknown_function"
    | "formula_cycle"
    | "formula_too_complex";
  path: string;
  message: string;
  /** For formula issues: the character span in the expression. */
  span?: { start: number; end: number };
}

function normaliseOptions(options: readonly unknown[] | undefined) {
  return options?.map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : {
          ...(option as { value: string; label?: string; color?: string }),
          label: (option as { label?: string }).label ?? (option as { value: string }).value ?? "",
        },
  );
}

function fieldToManifest(spec: Record<string, unknown>): Record<string, unknown> {
  const { options, ...rest } = spec;
  return {
    ...rest,
    ...(options ? { options: normaliseOptions(options as unknown[]) } : {}),
  };
}

function fieldsToManifest(fields: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([name, spec]) => [
      name,
      fieldToManifest(spec as Record<string, unknown>),
    ]),
  );
}

/**
 * Turns a live extension into its JSON manifest. Tool schemas become JSON Schema. Runs wherever
 * the extension is loaded (the sandbox, or the testing harness).
 */
export function toManifest(extension: Extension): ExtensionManifest {
  const raw = {
    id: extension.id,
    version: extension.version,
    contractVersion: extension.contractVersion,
    ...(extension.label ? { label: extension.label } : {}),
    ...(extension.description ? { description: extension.description } : {}),
    permissions: extension.permissions ?? {},
    objects: Object.fromEntries(
      Object.entries(extension.objects ?? {}).map(([name, object]) => [
        name,
        { ...object, fields: fieldsToManifest(object.fields as Record<string, unknown>) },
      ]),
    ),
    fields: Object.fromEntries(
      Object.entries(extension.fields ?? {}).map(([target, fields]) => [
        target,
        fieldsToManifest(fields as Record<string, unknown>),
      ]),
    ),
    views: extension.views ?? {},
    dashboards: extension.dashboards ?? {},
    recordTabs: extension.recordTabs ?? {},
    recordPanels: extension.recordPanels ?? {},
    settings: Object.fromEntries(
      Object.entries(extension.settings ?? {}).map(([name, setting]) => [
        name,
        fieldToManifest(setting as unknown as Record<string, unknown>),
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(extension.tools ?? {}).map(([name, tool]) => [
        name,
        {
          description: tool.description,
          risk: tool.risk ?? "write",
          ...(tool.recordAction ? { recordAction: tool.recordAction } : {}),
          ...(tool.audiences ? { audiences: [...tool.audiences] } : {}),
          ...(tool.permission
            ? {
                permission:
                  typeof tool.permission === "string" ? tool.permission : [...tool.permission],
              }
            : {}),
          ...(tool.humanOnly ? { humanOnly: true as const } : {}),
          ...(tool.personApproves ? { personApproves: true as const } : {}),
          ...(tool.grantLiftsRoleLimits ? { grantLiftsRoleLimits: true as const } : {}),
          ...(tool.customerFields
            ? {
                customerFields: Object.fromEntries(
                  Object.entries(tool.customerFields).map(([object, fields]) => [
                    object,
                    [...fields],
                  ]),
                ),
              }
            : {}),
          inputSchema: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
          outputSchema: z.toJSONSchema(tool.output, { io: "output", unrepresentable: "any" }),
        },
      ]),
    ),
    automations: Object.fromEntries(
      Object.entries(extension.automations ?? {}).map(([name, automation]) => [
        name,
        {
          label: automation.label,
          description: automation.description,
          trigger: automation.trigger,
          ...(automation.conditions ? { conditions: automation.conditions } : {}),
          steps: automation.steps,
          ...(automation.onRejected ? { onRejected: automation.onRejected } : {}),
          ...(automation.rails ? { rails: automation.rails } : {}),
          ...(automation.connections?.length ? { connections: automation.connections } : {}),
          ...(automation.enabled === false ? { enabled: false } : {}),
        },
      ]),
    ),
    ...(extension.grantable ? { grantable: [...extension.grantable] } : {}),
    ...(extension.grantableLabels ? { grantableLabels: { ...extension.grantableLabels } } : {}),
    ...(extension.requires?.length ? { requires: [...extension.requires] } : {}),
    roles: Object.fromEntries(
      Object.entries(extension.roles ?? {}).map(([name, role]) => [
        name,
        {
          label: role.label,
          description: role.description,
          permissions: [...role.permissions],
          read: [...role.read],
          ...(role.today ? { today: { ...role.today } } : {}),
        },
      ]),
    ),
  };
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    // Return what we have; validateManifest reports the structural issues.
    return raw as unknown as ExtensionManifest;
  }
  return parsed.data;
}

/**
 * Core fields formulas on core objects can read, by formula type. The host checks this list
 * against its field registry (packages/core/test/sdk-core-fields.test.ts), so the SDK and the
 * testing harness agree with the host without depending on it.
 */
export const CORE_FORMULA_FIELDS: Record<
  (typeof CORE_OBJECT_NAMES)[number],
  Record<string, "text" | "number" | "boolean" | "date" | "datetime">
> = {
  person: {
    id: "text",
    displayName: "text",
    givenName: "text",
    familyName: "text",
    primaryEmail: "text",
    primaryPhone: "text",
    jobTitle: "text",
    organisationId: "text",
    organisationName: "text",
    location: "text",
    timezone: "text",
    ownerId: "text",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  organisation: {
    id: "text",
    name: "text",
    primaryDomain: "text",
    website: "text",
    industry: "text",
    parentId: "text",
    parentName: "text",
    ownerId: "text",
    currentPeopleCount: "number",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  activity: {
    id: "text",
    type: "text",
    subject: "text",
    body: "text",
    occurredAt: "datetime",
    authorUserId: "text",
    authorActor: "text",
    createdAt: "datetime",
  },
  task: {
    id: "text",
    title: "text",
    notes: "text",
    dueAt: "datetime",
    status: "text",
    completedAt: "datetime",
    assigneeId: "text",
    createdBy: "text",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
};

function coreFormulaRefs(object: string): Record<string, FormulaFieldRef> {
  const fields = (CORE_FORMULA_FIELDS as Record<string, Record<string, string>>)[object];
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [name, { type, sql: name } as FormulaFieldRef]),
  );
}

export interface ValidateOptions {
  /**
   * Fields a formula on `object` may read, other than the extension's own fields on it: the
   * host supplies core and installed fields. Default: none.
   */
  baseFields?: (object: string) => Record<string, FormulaFieldRef>;
  /** Objects that exist outside this extension (`person`, `other.thing`). Default: core only. */
  knownObjects?: readonly string[];
  /**
   * Field types of objects outside this extension (installed extensions' objects), for the
   * automation checks; null when unknown (those checks are skipped). Core objects are built in.
   */
  objectFields?: (object: string) => Record<string, FieldTypeName> | null;
  /**
   * Further ids no extension may take: the host passes the namespaces of its own permissions
   * (`agreements`, `orders`, `people`, …), derived from its permission list, so a pack can never
   * declare a core permission such as `agreements:manage` as its own grantable one.
   */
  reservedIds?: readonly string[];
}

/** Formula environment for a set of field manifests (formula fields compile on demand). */
export function formulaFields(
  fields: Record<string, FieldManifest>,
): Record<string, FormulaFieldRef> {
  const env: Record<string, FormulaFieldRef> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field.type === "formula") {
      env[name] = { expression: field.expression ?? "" };
      continue;
    }
    const type = formulaTypeOf(field.type, field.many);
    if (type) env[name] = { type, sql: `"${name}"` };
  }
  return env;
}

/**
 * The contract check: structure (zod), names, references, permissions and formulas. Returns
 * every issue found (empty when the manifest is valid) and the parsed manifest when it parsed.
 */
export function validateManifest(
  input: unknown,
  options: ValidateOptions = {},
): { manifest: ExtensionManifest | null; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const contract = (path: string, message: string) =>
    issues.push({ code: "contract", path, message });

  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      contract(issue.path.join(".") || "(root)", issue.message);
    }
    return { manifest: null, issues };
  }
  const m = parsed.data;

  if (
    !EXTENSION_ID_RE.test(m.id) ||
    RESERVED_EXTENSION_IDS.has(m.id) ||
    options.reservedIds?.includes(m.id)
  ) {
    contract(
      "id",
      `Extension id "${m.id}" must be 2-30 lowercase letters or digits, start with a letter, and not be reserved`,
    );
  }
  if (!SEMVER_RE.test(m.version))
    contract("version", `Version "${m.version}" must be semver, e.g. 1.0.0`);
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(m.contractVersion)) {
    contract(
      "contractVersion",
      `Contract version ${m.contractVersion} is not supported (supported: ${SUPPORTED_CONTRACT_VERSIONS.join(", ")})`,
    );
  }

  const ownObjects = Object.keys(m.objects).map((name) => `${m.id}.${name}`);
  const known = new Set<string>([
    ...CORE_OBJECT_NAMES,
    ...(options.knownObjects ?? []),
    ...ownObjects,
  ]);

  const checkFields = (
    base: string,
    object: string,
    fields: Record<string, FieldManifest>,
    env: Record<string, FormulaFieldRef>,
  ) => {
    for (const [name, field] of Object.entries(fields)) {
      const path = `${base}.${name}`;
      if (!FIELD_NAME_RE.test(name)) {
        contract(
          path,
          `Field name "${name}" must be camelCase letters and digits, starting lowercase`,
        );
      }
      if (RESERVED_FIELD_NAMES.has(name)) contract(path, `"${name}" is reserved on every record`);
      if (field.renamedFrom !== undefined && !FIELD_NAME_RE.test(field.renamedFrom)) {
        contract(`${path}.renamedFrom`, "renamedFrom must be a valid field name");
      }
      if (field.renamedFrom === name)
        contract(`${path}.renamedFrom`, "renamedFrom equals the name");
      if (field.type === "select" || field.type === "multiSelect") {
        if (!field.options?.length)
          contract(`${path}.options`, `${field.type} fields need options`);
        const values = field.options?.map((o) => o.value) ?? [];
        if (new Set(values).size !== values.length) {
          contract(`${path}.options`, "Option values must be unique");
        }
        for (const option of field.options ?? []) {
          if (!option.requires?.length) continue;
          if (field.type !== "select") {
            contract(`${path}.options`, "Only select fields take `requires`");
            continue;
          }
          for (const required of option.requires) {
            if (!(required in fields)) {
              contract(
                `${path}.options`,
                `Option "${option.value}" requires "${required}", which is not a field here`,
              );
            }
          }
        }
        if (!field.editableOptions && field.options?.some((o) => o.fixed !== undefined)) {
          contract(`${path}.options`, "Only fields with editableOptions take `fixed`");
        }
      } else if (field.options) {
        contract(`${path}.options`, `Only select and multiSelect fields take options`);
      }
      if (
        field.editableOptions !== undefined &&
        field.type !== "select" &&
        field.type !== "multiSelect"
      ) {
        contract(
          `${path}.editableOptions`,
          "Only select and multiSelect fields take editableOptions",
        );
      }
      if (field.type === "relation") {
        if (!field.to) contract(`${path}.to`, "relation fields need `to`");
        else if (
          !(RELATION_CORE_TARGETS as readonly string[]).includes(field.to) &&
          !(field.to.includes(".") && known.has(field.to))
        ) {
          contract(
            `${path}.to`,
            `Unknown relation target "${field.to}". Use person, organisation, task or <extension>.<object>`,
          );
        }
      } else if (field.to !== undefined || field.many !== undefined) {
        contract(path, "Only relation fields take `to` and `many`");
      }
      if (field.type === "currency" && field.currency === undefined) {
        // Default applied by the host; nothing to report.
      } else if (field.type !== "currency" && field.currency !== undefined) {
        contract(`${path}.currency`, "Only currency fields take `currency`");
      }
      if (field.readOnly && field.required) {
        contract(`${path}.readOnly`, "A read-only field is set by the host and cannot be required");
      }
      checkDocumentField(path, name, field, fields, known, contract);
      if (["number", "currency", "percent"].includes(field.type)) {
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
          contract(`${path}.min`, "min is above max");
        }
        if (typeof field.default === "number") {
          const d = field.default;
          const step = field.step;
          if (
            (field.min !== undefined && d < field.min) ||
            (field.max !== undefined && d > field.max) ||
            (step !== undefined && !onStep(d, field.min ?? 0, step))
          ) {
            contract(`${path}.default`, "The default is outside the field's min, max or step");
          }
        }
      } else {
        for (const key of ["min", "max", "step"] as const) {
          if (field[key] !== undefined)
            contract(`${path}.${key}`, `Only number fields take ${key}`);
        }
      }
      if (field.type === "formula") {
        if (field.required) contract(`${path}.required`, "Formula fields cannot be required");
        if (field.track)
          contract(`${path}.track`, "Formula fields cannot be tracked on the timeline");
        if (!field.expression?.trim()) {
          contract(`${path}.expression`, "formula fields need an expression");
        } else {
          const result = checkFormula(field.expression, { fields: env }, name);
          if (!result.ok) {
            issues.push({
              code: result.issue.code,
              path: `${path}.expression`,
              message: `${object}.${name}: ${result.issue.message}`,
              span: result.issue.span,
            });
          }
        }
      } else if (field.expression !== undefined) {
        contract(`${path}.expression`, "Only formula fields take an expression");
      }
    }
  };

  for (const [name, object] of Object.entries(m.objects)) {
    const path = `objects.${name}`;
    if (!OBJECT_NAME_RE.test(name)) {
      contract(
        path,
        `Object name "${name}" must be lowercase letters and digits, starting with a letter`,
      );
    }
    if (RESERVED_OBJECT_NAMES.has(name)) contract(path, `"${name}" is a reserved object name`);
    if (object.renamedFrom !== undefined && !OBJECT_NAME_RE.test(object.renamedFrom)) {
      contract(`${path}.renamedFrom`, "renamedFrom must be a valid object name");
    }
    const title = object.fields[object.titleField];
    if (!title) {
      contract(`${path}.titleField`, `titleField "${object.titleField}" is not a field of ${name}`);
    } else if (!TEXT_LIKE.includes(title.type)) {
      contract(
        `${path}.titleField`,
        `titleField must be a text-like field (${TEXT_LIKE.join(", ")})`,
      );
    }
    // Every record's own timestamps can be read too, as on the host (formulaEnvironment).
    const env = {
      createdAt: { type: "datetime", sql: '"created_at"' } as FormulaFieldRef,
      updatedAt: { type: "datetime", sql: '"updated_at"' } as FormulaFieldRef,
      ...formulaFields(object.fields),
    };
    checkFields(`${path}.fields`, `${m.id}.${name}`, object.fields, env);
    checkObjectBehaviour(m, name, object, contract);
    checkObjectCapacity(m, name, object, contract);
    checkObjectSellable(m, name, object, contract);
    checkObjectAllowance(m, name, object, contract);
    checkObjectAgreements(m, name, object, contract);
    checkObjectHealthNotes(m, name, object, contract);
    checkObjectStates(m, name, object, contract);
    checkObjectClaims(m, name, object, contract);
    checkObjectUnique(m, name, object, contract);
    checkObjectRecurring(m, name, object, contract);
    checkObjectStaffed(m, name, object, contract);
    object.requireOneOf?.forEach((group, i) => {
      for (const field of group) {
        if (!object.fields[field]) {
          contract(`${path}.requireOneOf.${i}`, `"${field}" is not a field of ${name}`);
        }
      }
    });
    for (const field of object.titleDefault?.from ?? []) {
      if (object.fields[field]?.type !== "relation") {
        contract(`${path}.titleDefault`, `"${field}" is not a relation field of ${name}`);
      }
    }
    for (const [fieldName, field] of Object.entries(object.fields)) {
      const fieldPath = `${path}.fields.${fieldName}`;
      if (field.default !== undefined) {
        const expected =
          field.type === "boolean"
            ? "boolean"
            : ["number", "currency", "percent"].includes(field.type)
              ? "number"
              : ["text", "longText", "select", "date", "email", "phone", "url"].includes(field.type)
                ? "string"
                : null;
        if (!expected) contract(`${fieldPath}.default`, `${field.type} fields take no default`);
        else if (typeof field.default !== expected) {
          contract(`${fieldPath}.default`, `The default must be a ${expected}`);
        } else if (
          field.type === "select" &&
          !field.options?.some((o) => o.value === field.default)
        ) {
          contract(`${fieldPath}.default`, "The default must be one of the options");
        }
      }
      if (field.defaultSetting !== undefined && !m.settings[field.defaultSetting]) {
        contract(
          `${fieldPath}.defaultSetting`,
          `"${field.defaultSetting}" is not one of this extension's settings`,
        );
      }
    }
    if (object.owner !== undefined) {
      const owner = object.fields[object.owner];
      if (!owner) contract(`${path}.owner`, `owner "${object.owner}" is not a field of ${name}`);
      else if (owner.type !== "user") contract(`${path}.owner`, "owner must name a user field");
    }
    if (object.customer !== undefined) {
      const c = object.customer;
      const whose = object.fields[c.field];
      if (!whose) {
        contract(`${path}.customer.field`, `customer field "${c.field}" is not a field of ${name}`);
      } else if (whose.type !== "relation" || whose.to !== "person" || whose.many) {
        contract(`${path}.customer.field`, "customer.field must be a relation to one person");
      }
      for (const key of ["read", "write"] as const) {
        if (new Set(c[key]).size !== c[key].length) {
          contract(`${path}.customer.${key}`, `customer.${key} lists a field twice`);
        }
        for (const fieldName of c[key]) {
          if (!object.fields[fieldName]) {
            contract(
              `${path}.customer.${key}`,
              `customer.${key} lists "${fieldName}", which is not a field of ${name}`,
            );
          }
        }
      }
      for (const fieldName of c.write) {
        if (fieldName === c.field) {
          contract(`${path}.customer.write`, "customer.write may not list the customer field");
        }
        if (!c.read.includes(fieldName)) {
          contract(
            `${path}.customer.write`,
            `customer.write lists "${fieldName}", which customer.read does not`,
          );
        }
      }
    }
  }

  // What the public may read (ADR 0438): fields of the object's own, and a condition on a
  // state of the record or of one record of this extension it points to.
  // What every signed-in customer may read (ADR 0447) has the same shape and the same checks.
  const readDeclarations = Object.entries(m.objects).flatMap(([name, object]) =>
    (["public", "signedIn"] as const).flatMap((key) => {
      const declared = object[key];
      return declared ? [{ name, object, key, p: declared }] : [];
    }),
  );
  for (const { name, object, key, p } of readDeclarations) {
    const path = `objects.${name}.${key}`;
    if (key === "public" && object.customer) {
      contract(path, "An object declares customer or public, not both");
    }
    if (key === "signedIn" && object.public) {
      contract(
        path,
        "An object declares public or signedIn, not both: the public's is read by customers too",
      );
    }
    if (new Set(p.read).size !== p.read.length)
      contract(`${path}.read`, `${key}.read lists a field twice`);
    for (const fieldName of p.read) {
      const hostField =
        key === "public" &&
        object.publishable !== undefined &&
        (fieldName === "publishedAt" || fieldName === "publishedVersion");
      if (!object.fields[fieldName] && !hostField) {
        contract(
          `${path}.read`,
          `${key}.read lists "${fieldName}", which is not a field of ${name}`,
        );
      }
    }
    if (key === "signedIn" && object.customer) {
      // Shared records are read with the fields a customer reads of their own, and no other.
      for (const fieldName of p.read) {
        if (!object.customer.read.includes(fieldName)) {
          contract(
            `${path}.read`,
            `signedIn.read lists "${fieldName}", which customer.read does not: a shared record shows no more than one's own`,
          );
        }
      }
    }
    if (!p.when) continue;
    let target = object;
    let targetName = name;
    if (p.when.via !== undefined) {
      const via = object.fields[p.when.via];
      const local =
        via?.type === "relation" && !via.many && via.to?.startsWith(`${m.id}.`)
          ? via.to.slice(m.id.length + 1)
          : null;
      const pointed = local ? m.objects[local] : undefined;
      if (!pointed || !local) {
        contract(
          `${path}.when.via`,
          `${key}.when.via must name a relation of ${name} to one record of another of this extension's objects`,
        );
        continue;
      }
      target = pointed;
      targetName = local;
    }
    const field = target.fields[p.when.field];
    if (!field || field.type !== "select") {
      contract(`${path}.when.field`, `${key}.when.field must name a select field of ${targetName}`);
      continue;
    }
    const values = new Set((field.options ?? []).map((o) => (typeof o === "string" ? o : o.value)));
    for (const value of p.when.in) {
      if (!values.has(value)) {
        contract(`${path}.when.in`, `"${value}" is not an option of ${targetName}.${p.when.field}`);
      }
    }
  }

  // Versions (ADR 0446): the content a version keeps is fields of the object's own that a person
  // edits, and the host's two published fields are not taken.
  for (const [name, object] of Object.entries(m.objects)) {
    const p = object.publishable;
    if (!p) continue;
    const path = `objects.${name}.publishable`;
    if (new Set(p.content).size !== p.content.length) {
      contract(`${path}.content`, "publishable.content lists a field twice");
    }
    for (const fieldName of p.content) {
      const field = object.fields[fieldName];
      if (!field) {
        contract(`${path}.content`, `"${fieldName}" is not a field of ${name}`);
      } else if (field.type === "formula" || field.readOnly) {
        contract(
          `${path}.content`,
          `"${fieldName}" is ${field.type === "formula" ? "a formula" : "read-only"}: content is what staff edit`,
        );
      }
    }
    // The address and the date a reader is shown (stage 28, ADR 0441, ADR 0442).
    if (p.slug !== undefined) {
      const slug = object.fields[p.slug];
      if (slug?.type !== "slug") {
        contract(`${path}.slug`, `publishable.slug must name a slug field of ${name}`);
      } else if (p.content.includes(p.slug)) {
        contract(
          `${path}.slug`,
          "The slug is the record's address, not content: leave it out of content",
        );
      }
    }
    if (p.date !== undefined) {
      const date = object.fields[p.date];
      if (!date || (date.type !== "date" && date.type !== "datetime")) {
        contract(`${path}.date`, `publishable.date must name a date or datetime field of ${name}`);
      } else if (!p.content.includes(p.date)) {
        contract(`${path}.date`, "publishable.date is content: list it in content too");
      }
    }
    if (object.public) {
      if (p.slug === undefined) {
        contract(`${path}.slug`, "A publishable object the public reads names its slug field");
      }
      // The public reads the published version (ADR 0442): its content, its address and when it
      // went live, and fields the host keeps on the working copy that are not computed from it.
      for (const fieldName of object.public.read) {
        const field = object.fields[fieldName];
        if (field?.type === "formula") {
          contract(
            `objects.${name}.public.read`,
            `public.read lists "${fieldName}", a formula: on a publishable object a formula reads the working copy`,
          );
        }
      }
    }
    if (object.customer || object.customerVia) {
      contract(
        path,
        "A publishable object declares no customer or customerVia: what outsiders read of it is its published version",
      );
    }
    for (const taken of PUBLISHED_FIELD_NAMES) {
      const clash =
        Object.hasOwn(object.fields, taken) ||
        Object.values(object.fields).some((f) => f.paths && taken in f.paths);
      if (clash) {
        contract(
          `objects.${name}.fields.${taken}`,
          `"${taken}" is the host's on a publishable object`,
        );
      }
    }
  }

  // What a customer reads of a record their own record points to (ADR 0439): fields of this
  // object, through a relation of another of this extension's objects that declares a customer.
  for (const [name, object] of Object.entries(m.objects)) {
    const v = object.customerVia;
    if (!v) continue;
    const path = `objects.${name}.customerVia`;
    if (object.customer) {
      contract(path, "An object that declares a customer cannot also declare customerVia");
    }
    if (new Set(v.read).size !== v.read.length) {
      contract(`${path}.read`, "customerVia.read lists a field twice");
    }
    for (const fieldName of v.read) {
      if (!object.fields[fieldName]) {
        contract(
          `${path}.read`,
          `customerVia.read lists "${fieldName}", which is not a field of ${name}`,
        );
      }
    }
    const local = v.from.startsWith(`${m.id}.`) ? v.from.slice(m.id.length + 1) : null;
    const from = local ? m.objects[local] : undefined;
    if (!from || local === name) {
      contract(
        `${path}.from`,
        `customerVia.from must name another of this extension's objects, as ${m.id}.<object>`,
      );
      continue;
    }
    if (!from.customer) {
      contract(`${path}.from`, "customerVia.from must name an object that declares a customer");
      continue;
    }
    const pointer = from.fields[v.field];
    if (pointer?.type !== "relation" || pointer.many || pointer.to !== `${m.id}.${name}`) {
      contract(
        `${path}.field`,
        `customerVia.field must name a relation of ${local} to one ${name}`,
      );
    } else if (!from.customer.read.includes(v.field)) {
      contract(
        `${path}.field`,
        `customerVia.field "${v.field}" must be one ${local}'s customer may read (customer.read)`,
      );
    }
  }

  // The extensions this one needs installed first (stage 42): never itself, each once.
  for (const [i, required] of (m.requires ?? []).entries()) {
    if (required === m.id) contract(`requires.${i}`, "An extension does not require itself");
    if ((m.requires ?? []).indexOf(required) !== i) {
      contract(`requires.${i}`, `"${required}" is listed twice`);
    }
  }

  // Fields a customer sets only when they make the record (ADR 0507): each one of its write list.
  for (const [name, object] of Object.entries(m.objects)) {
    for (const fieldName of object.customer?.createOnly ?? []) {
      if (!object.customer?.write.includes(fieldName)) {
        contract(
          `objects.${name}.customer.createOnly`,
          `"${fieldName}" must be one the customer writes (customer.write)`,
        );
      }
    }
  }

  // The family link (ADR 0540): who made a record is a relation to one person the host sets, never
  // one the customer writes.
  for (const [name, object] of Object.entries(m.objects)) {
    const madeBy = object.customer?.guardians?.madeBy;
    if (madeBy === undefined) continue;
    const path = `objects.${name}.customer.guardians.madeBy`;
    const field = object.fields[madeBy];
    if (field?.type !== "relation" || field.to !== "person" || field.many) {
      contract(path, `"${madeBy}" must be a relation of ${name} to one person`);
    } else if (!field.readOnly) {
      contract(path, `"${madeBy}" must be readOnly: the host sets it, nobody edits it`);
    } else if (madeBy === object.customer?.field) {
      contract(path, "madeBy cannot be the customer field");
    } else if (object.customer?.write.includes(madeBy)) {
      contract(path, `"${madeBy}" is set by the host: customer.write may not list it`);
    }
  }

  // A customer's write that needs access to what it points to (stage 42, ADR 0478): relations of
  // the object to one record of another of this extension's objects that declares `access`.
  for (const [name, object] of Object.entries(m.objects)) {
    for (const fieldName of object.customer?.requireAccess ?? []) {
      const path = `objects.${name}.customer.requireAccess`;
      const field = object.fields[fieldName];
      const local = field?.to?.startsWith(`${m.id}.`) ? field.to.slice(m.id.length + 1) : null;
      const target = local ? m.objects[local] : undefined;
      if (field?.type !== "relation" || field.many || !target) {
        contract(
          path,
          `"${fieldName}" must be a relation of ${name} to one of this extension's objects`,
        );
      } else if (!target.access) {
        contract(path, `"${fieldName}" points to ${local}, which declares no access`);
      } else if (!object.customer?.read.includes(fieldName)) {
        contract(path, `"${fieldName}" must be one the customer reads (customer.read)`);
      }
    }
  }

  // Who holds access to a record (ADR 0477): sources of this extension's own records. A kind the
  // host provides is checked by the host, which knows its kinds; the subscription kind's options
  // (stage 32a, ADR 0488) are checked here too, as they name this extension's own plan object.
  for (const [name, object] of Object.entries(m.objects)) {
    const a = object.access;
    if (!a) continue;
    a.sources.forEach((given, i) => {
      const path = `objects.${name}.access.sources.${i}`;
      if ("kind" in given && given.kind === "subscription") {
        const options = (given.options ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(options)) {
          if (key !== "plans" && key !== "covers") {
            contract(`${path}.options.${key}`, `a subscription source has no option "${key}"`);
          }
        }
        if (options.covers !== "all") {
          contract(`${path}.options.covers`, 'covers must be "all": every live record');
        }
        const plans = typeof options.plans === "string" ? options.plans : "";
        const planLocal = plans.startsWith(`${m.id}.`) ? plans.slice(m.id.length + 1) : null;
        const plan = planLocal && planLocal !== name ? m.objects[planLocal] : undefined;
        if (!plan) {
          contract(
            `${path}.options.plans`,
            `plans must name another of this extension's objects, as ${m.id}.<object>`,
          );
        } else if (!plan.sellable?.recurring) {
          contract(
            `${path}.options.plans`,
            "plans must name a plan: its sellable declares recurring",
          );
        }
        return;
      }
      if (!("via" in given)) return;
      const source = given;
      const local = source.via.startsWith(`${m.id}.`) ? source.via.slice(m.id.length + 1) : null;
      const via = local ? m.objects[local] : undefined;
      if (!via || local === name) {
        contract(
          `${path}.via`,
          `via must name another of this extension's objects, as ${m.id}.<object>`,
        );
        return;
      }
      if (!via.customer) {
        contract(`${path}.via`, "via must name an object that declares a customer");
        return;
      }
      const pointer = via.fields[source.field];
      if (pointer?.type !== "relation" || pointer.many || !pointer.to) {
        contract(`${path}.field`, `field must name a relation of ${local} to one record`);
        return;
      }
      if (source.through === undefined) {
        if (pointer.to !== `${m.id}.${name}`) {
          contract(`${path}.field`, `field must be a relation of ${local} to one ${name}`);
        }
      } else {
        const targetLocal = pointer.to.startsWith(`${m.id}.`)
          ? pointer.to.slice(m.id.length + 1)
          : null;
        const target = targetLocal ? m.objects[targetLocal] : undefined;
        const list = target?.fields[source.through];
        const lists =
          (list?.type === "relation" && list.many && list.to === `${m.id}.${name}`) ||
          list?.type === "document";
        if (!target || !lists) {
          contract(
            `${path}.through`,
            `through must name a many relation to ${name}, or a document whose refs name it, on the object field points to`,
          );
        }
      }
      if (via.states) {
        const stateField = via.fields[via.states.field];
        const known = new Set((stateField?.options ?? []).map((o) => o.value));
        // What a refund moves a grant of `via` to: never a state that gives access.
        const voids = new Set(
          Object.values(m.objects).flatMap((o) => {
            const g = o.sellable?.grants;
            return g && (g.object === local || g.object === source.via) ? [g.void] : [];
          }),
        );
        if (!source.states?.length) {
          contract(`${path}.states`, `${local} has states: name the ones that give access`);
        } else {
          for (const st of source.states) {
            if (!known.has(st)) contract(`${path}.states`, `"${st}" is not a state of ${local}`);
            if (voids.has(st)) {
              contract(
                `${path}.states`,
                `"${st}" is where a refund moves ${local}: it gives no access`,
              );
            }
          }
        }
      } else if (source.states !== undefined) {
        contract(`${path}.states`, `${local} has no states`);
      }
      if (source.until !== undefined) {
        const until = via.fields[source.until];
        if (until?.type !== "date" && until?.type !== "datetime") {
          contract(`${path}.until`, `until must name a date or datetime field of ${local}`);
        }
      }
    });
  }

  for (const [target, fields] of Object.entries(m.fields)) {
    const path = `fields.${target}`;
    if (!known.has(target)) {
      contract(path, `Unknown object "${target}". Use a core object or <extension>.<object>`);
      continue;
    }
    if (target.startsWith(`${m.id}.`)) {
      contract(path, "Declare fields of your own objects in objects.<name>.fields");
      continue;
    }
    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.default !== undefined || field.defaultSetting !== undefined) {
        contract(`${path}.${fieldName}`, "Only fields of your own objects take a default");
      }
      if (field.type === "slug") {
        // A slug is unique in its object's own table (ADR 0442): an object's address is its own.
        contract(`${path}.${fieldName}`, "Only fields of your own objects can be a slug");
      }
    }
    const base = options.baseFields?.(target) ?? coreFormulaRefs(target);
    const env = { ...base, ...formulaFields(fields) };
    checkFields(path, target, fields, env);
  }

  for (const [name, tool] of Object.entries(m.tools)) {
    if (!TOOL_NAME_RE.test(name)) {
      contract(`tools.${name}`, `Tool name "${name}" must be camelCase letters and digits`);
    }
    if (tool.inputSchema.type !== "object") {
      contract(`tools.${name}.input`, "A tool's input must be a z.object(...)");
    }
    const open = (tool.audiences ?? []).filter((audience) => audience !== "staff");
    if (tool.audiences && new Set(tool.audiences).size !== tool.audiences.length) {
      contract(`tools.${name}.audiences`, "audiences lists one twice");
    }
    if (tool.humanOnly && open.length) {
      contract(
        `tools.${name}.humanOnly`,
        `A tool only a person on the staff may call cannot be open to ${open.join(" and ")} callers`,
      );
    }
    if (tool.personApproves && (open.length || tool.risk === "read")) {
      contract(
        `tools.${name}.personApproves`,
        "A tool a person approves is a staff tool that changes something: not open to customers or the public, and not a read",
      );
    }
    if (open.length && tool.risk !== "read" && tool.risk !== "write") {
      contract(
        `tools.${name}.risk`,
        `A tool open to ${open.join(" and ")} callers must have risk read or write, not ${tool.risk}`,
      );
    }
    if (tool.customerFields) {
      if (!tool.audiences?.includes("customer")) {
        contract(
          `tools.${name}.customerFields`,
          "customerFields is only for a tool open to customer",
        );
      }
      for (const [objectName, fieldNames] of Object.entries(tool.customerFields)) {
        const local = objectName.startsWith(`${m.id}.`) ? objectName.slice(m.id.length + 1) : null;
        const own = local ? m.objects[local] : undefined;
        if (!own) {
          contract(
            `tools.${name}.customerFields.${objectName}`,
            `customerFields names "${objectName}", which is not an object of this extension`,
          );
          continue;
        }
        if (!own.customer) {
          contract(
            `tools.${name}.customerFields.${objectName}`,
            `${objectName} declares no customer, so a customer has no record of it to change`,
          );
          continue;
        }
        for (const fieldName of fieldNames) {
          if (fieldName === "id" || fieldName === own.customer.field) {
            contract(
              `tools.${name}.customerFields.${objectName}`,
              `A tool may never set "${fieldName}": whose record it is, and its id, are the host's`,
            );
          } else if (!own.fields[fieldName]) {
            contract(
              `tools.${name}.customerFields.${objectName}`,
              `"${fieldName}" is not a field of ${objectName}`,
            );
          }
        }
      }
    }
    if (tool.permission !== undefined) {
      const permissions = toolPermissions(tool);
      for (const permission of permissions) {
        const match = EXTENSION_PERMISSION_RE.exec(permission);
        if (!match || match[1] !== m.id) {
          contract(
            `tools.${name}.permission`,
            `A tool's permission is named ${m.id}:<word> (camelCase), not "${permission}"`,
          );
        }
      }
      if (new Set(permissions).size !== permissions.length) {
        contract(`tools.${name}.permission`, "A tool names each permission once");
      }
      if (tool.audiences && !tool.audiences.includes("staff")) {
        contract(
          `tools.${name}.permission`,
          "A permission is for staff callers; this tool is not open to staff",
        );
      }
    }
    if (tool.recordAction) {
      const action = tool.recordAction;
      if (!known.has(action.object)) {
        contract(`tools.${name}.recordAction.object`, `Unknown object "${action.object}"`);
      }
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
      if (properties[action.idInput]?.type !== "string") {
        contract(
          `tools.${name}.recordAction.idInput`,
          `idInput "${action.idInput}" must be a string field of the tool's input`,
        );
      }
      if (action.ask && !properties[action.ask.input]) {
        contract(
          `tools.${name}.recordAction.ask`,
          `"${action.ask.input}" is not a field of the tool's input`,
        );
      }
    }
  }

  // Grantable permissions (ADR 0449): permissions this extension's tools declare, for staff.
  // A permission one of its roles holds is not grantable (ADR 0600): a role's limits (today's
  // records only) bind what the role gives, and a grant of the same name would lift them.
  const roleHeld = new Set(Object.values(m.roles).flatMap((role) => role.permissions));
  (m.grantable ?? []).forEach((permission, i) => {
    const tool = Object.values(m.tools).find((t) => toolPermissions(t).includes(permission));
    if (!tool) {
      contract(
        `grantable.${i}`,
        `"${permission}" is not the permission of any of this extension's tools (tools.<name>.permission)`,
      );
    }
    if (roleHeld.has(permission)) {
      contract(
        `grantable.${i}`,
        `"${permission}" is held by a role of this extension, so it cannot be granted one by one: name a permission of its own on the tools a grant opens`,
      );
    }
  });
  // A tool a role reaches and a grant opens too is the grant's without the role's limits (ADR
  // 0600): only where the tool says so, so a grantable permission added to a role's own tool is
  // refused rather than silently lifting the role's today off it.
  for (const [name, tool] of Object.entries(m.tools)) {
    const permissions = toolPermissions(tool);
    const both =
      permissions.some((p) => roleHeld.has(p)) &&
      permissions.some((p) => (m.grantable ?? []).includes(p));
    if (both && !tool.grantLiftsRoleLimits) {
      contract(
        `tools.${name}.permission`,
        "This tool names a permission a role holds and a grantable one, so a grant would open it without the role's limits: set grantLiftsRoleLimits if that is meant, or give the grant a tool of its own",
      );
    }
    if (tool.grantLiftsRoleLimits && !both) {
      contract(
        `tools.${name}.grantLiftsRoleLimits`,
        "grantLiftsRoleLimits is for a tool naming both a permission a role holds and a grantable one",
      );
    }
  }
  for (const permission of Object.keys(m.grantableLabels ?? {})) {
    if (!(m.grantable ?? []).includes(permission)) {
      contract(`grantableLabels.${permission}`, `"${permission}" is not in grantable`);
    }
  }

  // Roles (ADR 0436): each holds permissions this extension's tools declare and reads objects
  // of its own, and nothing else, so a role can never reach past the extension that declares it.
  const declaredPermissions = new Set(
    Object.values(m.tools).flatMap((tool) => toolPermissions(tool)),
  );
  for (const [name, role] of Object.entries(m.roles)) {
    const path = `roles.${name}`;
    if (!FIELD_NAME_RE.test(name)) contract(path, `Role name "${name}" must be camelCase`);
    if (!role.permissions.length && !role.read.length) {
      contract(path, "A role holds at least one permission or reads at least one object");
    }
    for (const permission of role.permissions) {
      if (!declaredPermissions.has(permission)) {
        contract(
          `${path}.permissions`,
          `"${permission}" is not the permission of any of this extension's tools (tools.<name>.permission)`,
        );
      }
    }
    for (const object of role.read) {
      const local = object.startsWith(`${m.id}.`) ? object.slice(m.id.length + 1) : null;
      if (!local || !m.objects[local]) {
        contract(
          `${path}.read`,
          `"${object}" is not an object of this extension: a role reads ${m.id}.<object> only`,
        );
      }
    }
    // A role limited to today (ADR 0553): each object its own, each path a datetime on it (or
    // one relation away, through another of its objects).
    for (const [object, limit] of Object.entries(role.today ?? {})) {
      const tp = `${path}.today.${object}`;
      const local = object.startsWith(`${m.id}.`) ? object.slice(m.id.length + 1) : null;
      const target = local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
      if (!target) {
        contract(tp, `"${object}" is not an object of this extension`);
        continue;
      }
      const spec = typeof limit === "string" ? { at: limit } : limit;
      const prefix = (p: string) => (p.includes(".") ? p.split(".")[0] : null);
      const paths: [string | undefined, string][] = [
        [spec.at, "datetime"],
        [spec.until, "datetime"],
        [spec.zone, "timezone"],
      ];
      for (const [p, type] of paths) {
        if (p === undefined) continue;
        const field = p.split(".").length <= 2 ? resolveFieldPath(m, target, p) : undefined;
        if (field?.type !== type || field.many) {
          contract(tp, `"${p}" must be a ${type} field of ${object}, or one relation away`);
        }
        if (prefix(p) !== prefix(spec.at)) {
          contract(tp, `"${p}" must be read through the same relation as "${spec.at}"`);
        }
      }
    }
  }

  for (const [name, view] of Object.entries(m.views)) {
    if (!FIELD_NAME_RE.test(name)) contract(`views.${name}`, "View names must be camelCase");
    if (!known.has(view.object))
      contract(`views.${name}.object`, `Unknown object "${view.object}"`);
    if (view.type === "board" && !view.groupBy) {
      contract(`views.${name}.groupBy`, "board views need groupBy");
    }
    if (view.type === "calendar" && !view.dateField) {
      contract(`views.${name}.dateField`, "calendar views need dateField");
    }
  }

  const homes = Object.entries(m.dashboards).filter(([, d]) => d.home);
  for (const [name] of Object.entries(m.dashboards)) {
    if (!FIELD_NAME_RE.test(name))
      contract(`dashboards.${name}`, "Dashboard names must be camelCase");
  }
  if (homes.length > 1) contract("dashboards", "At most one dashboard can be the default Home");

  for (const [kind, entries] of [
    ["recordTabs", m.recordTabs],
    ["recordPanels", m.recordPanels],
  ] as const) {
    for (const [name, entry] of Object.entries(entries)) {
      const path = `${kind}.${name}`;
      if (!FIELD_NAME_RE.test(name)) contract(path, `${kind} names must be camelCase`);
      if (!known.has(entry.on)) contract(`${path}.on`, `Unknown object "${entry.on}"`);
      if (!known.has(entry.view.object)) {
        contract(`${path}.view.object`, `Unknown object "${entry.view.object}"`);
        continue;
      }
      // The extension's own objects can be checked here; the host checks the rest.
      const own = entry.view.object.startsWith(`${m.id}.`)
        ? m.objects[entry.view.object.slice(m.id.length + 1)]
        : undefined;
      if (own) {
        const relation = own.fields[entry.view.relation];
        if (!relation) {
          contract(
            `${path}.view.relation`,
            `${entry.view.object} has no field "${entry.view.relation}"`,
          );
        } else if (relation.type !== "relation" || relation.to !== entry.on) {
          contract(
            `${path}.view.relation`,
            `${entry.view.object}.${entry.view.relation} must be a relation to ${entry.on}`,
          );
        }
        for (const key of ["groupBy", "sumField", "dateField", "imageField"] as const) {
          const field = entry.view[key];
          if (field && !own.fields[field]) {
            contract(`${path}.view.${key}`, `${entry.view.object} has no field "${field}"`);
          }
        }
      }
      if (entry.view.type === "board" && !entry.view.groupBy) {
        contract(`${path}.view.groupBy`, "board views need groupBy");
      }
      if (entry.view.type === "calendar" && !entry.view.dateField) {
        contract(`${path}.view.dateField`, "calendar views need dateField");
      }
    }
  }

  for (const [name, setting] of Object.entries(m.settings)) {
    const path = `settings.${name}`;
    if (!FIELD_NAME_RE.test(name)) contract(path, "Setting names must be camelCase");
    if (setting.type === "select") {
      if (!setting.options?.length) contract(`${path}.options`, "select settings need options");
      if (
        setting.default !== undefined &&
        !setting.options?.some((o) => o.value === setting.default)
      ) {
        contract(`${path}.default`, "The default must be one of the options");
      }
    } else if (setting.options) {
      contract(`${path}.options`, "Only select settings take options");
    }
    const expected = { text: "string", select: "string", number: "number", boolean: "boolean" };
    if (setting.default !== undefined && typeof setting.default !== expected[setting.type]) {
      contract(`${path}.default`, `The default must be a ${expected[setting.type]}`);
    }
  }

  for (const [name, automation] of Object.entries(m.automations)) {
    checkAutomation(
      { manifest: m, known, objectFields: options.objectFields, contract },
      name,
      automation,
    );
  }

  const perms = m.permissions;
  for (const [key, list] of [
    ["read", perms.read],
    ["write", perms.write],
  ] as const) {
    list.forEach((object, i) => {
      if (!known.has(object)) contract(`permissions.${key}.${i}`, `Unknown object "${object}"`);
    });
  }
  perms.operations.forEach((operation, i) => {
    if (!OPERATION_RE.test(operation)) {
      contract(`permissions.operations.${i}`, `"${operation}" is not an operation name`);
    } else if (FORBIDDEN_OPERATION_PREFIXES.some((prefix) => operation.startsWith(prefix))) {
      contract(`permissions.operations.${i}`, `Extensions cannot be granted ${operation}`);
    }
  });
  const usesOps = perms.read.length > 0 || perms.write.length > 0 || perms.operations.length > 0;
  if (usesOps && !perms.modules.includes("ops")) {
    contract("permissions.modules", 'Object or operation permissions need the "ops" module');
  }

  return { manifest: m, issues };
}

export function declaredModules(manifest: ExtensionManifest): HostModuleName[] {
  return manifest.permissions.modules;
}
