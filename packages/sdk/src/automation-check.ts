// Contract checks for `automations` (ADR 0028, ADR 0131). Called by validateManifest for every
// declared automation, after the zod structure check. Every message names the problem and the fix
// in terms a model can act on: the field that does not exist and the ones that do, the permission
// to add, the step name that is repeated.
import {
  type AutomationManifest,
  type Duration,
  durationMs,
  MAX_MOMENT_MINUTES,
  type Recipient,
  type ValueMatch,
} from "./automation.ts";
import type { ViewFilter } from "./contract.ts";
import type { FieldTypeName } from "./field-types.ts";
import { checkFormula } from "./formula/compile.ts";
// A function, read at call time: manifest.ts imports this file too.
import { type ExtensionManifest, objectFormulaEnvironment } from "./manifest.ts";
import { resolveFieldPath } from "./states.ts";

/** Waits in one run (sleeps plus waitForEvent timeouts) add up to at most this. */
export const MAX_TOTAL_WAIT_DAYS = 365;
/** A waitForEvent without a timeout waits this long (ADR 0130). */
export const DEFAULT_WAIT_TIMEOUT: `${number} days` = "7 days";
/** Workflows event types: `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, at most 100 characters. */
export const WAIT_EVENT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;
const NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const OPERATION_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const DAY_MS = 86_400_000;

/** The operation an automation needs to notify anyone (`notifies`, `ctx.notify`, `onRejected`). */
export const NOTIFY_OPERATION = "notification.send";

/**
 * Field types of the core objects automations can trigger on and notify from (the host checks
 * this against its field registry, packages/core/test/sdk-core-fields.test.ts). `user` marks the
 * fields that hold a user id (`{ field }` and `{ managerOf }` recipients).
 */
export const CORE_AUTOMATION_FIELDS: Record<string, Record<string, FieldTypeName>> = {
  person: {
    displayName: "text",
    givenName: "text",
    familyName: "text",
    primaryEmail: "email",
    primaryPhone: "phone",
    jobTitle: "text",
    organisationId: "relation",
    location: "text",
    timezone: "text",
    ownerId: "user",
    createdBy: "user",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  organisation: {
    name: "text",
    primaryDomain: "text",
    website: "url",
    industry: "text",
    parentId: "relation",
    ownerId: "user",
    createdBy: "user",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  task: {
    title: "text",
    notes: "longText",
    dueAt: "datetime",
    status: "select",
    completedAt: "datetime",
    assigneeId: "user",
    createdBy: "user",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  activity: {
    type: "select",
    subject: "text",
    body: "longText",
    occurredAt: "datetime",
    authorUserId: "user",
    createdAt: "datetime",
  },
};

/**
 * Base records with operations of their own (stage 25's orders) that an automation may be
 * started by (stage 27): a ticket sent when an order is first paid. They are not core objects:
 * nothing else in a manifest may name them, and the automation reads one only through its
 * `<object>.get`, which it must list in permissions.operations.
 */
export const BASE_AUTOMATION_FIELDS: Record<string, Record<string, FieldTypeName>> = {
  order: {
    state: "select",
    email: "email",
    personId: "relation",
    currency: "text",
    total: "number",
    paid: "number",
    balance: "number",
    pay: "select",
    deposit: "number",
    balanceDueAt: "datetime",
    paidAt: "datetime",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
};

/** Fields every extension record has besides its declared ones. */
const RECORD_FIELDS: Record<string, FieldTypeName> = {
  createdAt: "datetime",
  updatedAt: "datetime",
  createdBy: "user",
};

export interface AutomationCheckContext {
  manifest: ExtensionManifest;
  /** Objects that exist (core, this extension's, installed ones the host knows). */
  known: ReadonlySet<string>;
  /** Field types of an object outside this extension, from the host; null: unknown (skip). */
  objectFields?: (object: string) => Record<string, FieldTypeName> | null;
  contract(path: string, message: string): void;
}

const list = (names: string[]) => (names.length ? names.join(", ") : "none");

/** Field name → type for `object`, or null when this check cannot know its fields. */
function fieldsOf(
  ctx: AutomationCheckContext,
  object: string,
): Record<string, FieldTypeName> | null {
  const m = ctx.manifest;
  // Fields this extension adds to another object, by local name and by registry name
  // (`<ext>.<field>`, what record changes and so fieldChanged triggers use).
  const added = Object.fromEntries(
    Object.entries(m.fields[object] ?? {}).flatMap(([name, field]) => [
      [name, field.type],
      [`${m.id}.${name}`, field.type],
    ]),
  );
  if (object.startsWith(`${m.id}.`)) {
    const own = m.objects[object.slice(m.id.length + 1)];
    if (!own) return null;
    // A formula whose value is a date or a time counts as one (ADR 0706): a date-relative trigger
    // on it reads its rec_* column, as on any date field (a procedure's next review).
    const env = objectFormulaEnvironment(own);
    const typeOf = (name: string, f: (typeof own.fields)[string]): FieldTypeName => {
      if (f.type !== "formula") return f.type;
      const compiled = checkFormula(f.expression ?? "", { fields: env }, name);
      return compiled.ok &&
        (compiled.formula.type === "date" || compiled.formula.type === "datetime")
        ? compiled.formula.type
        : f.type;
    };
    return {
      ...RECORD_FIELDS,
      ...Object.fromEntries(Object.entries(own.fields).map(([name, f]) => [name, typeOf(name, f)])),
    };
  }
  const core = CORE_AUTOMATION_FIELDS[object] ?? BASE_AUTOMATION_FIELDS[object];
  if (core) return { ...core, ...added };
  const host = ctx.objectFields?.(object);
  return host ? { ...RECORD_FIELDS, ...host, ...added } : null;
}

/** The object a trigger hands its run as the trigger record (null: none). */
export function triggerObject(trigger: AutomationManifest["trigger"]): string | null {
  switch (trigger.type) {
    case "record":
    case "fieldChanged":
    case "dateRelative":
    case "manual":
      return trigger.object;
    // The synced email or meeting (an activity) is the trigger record.
    case "syncEvent":
      return "activity";
    default:
      return null;
  }
}

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
] as const;

/** Problems with a 5-field cron expression (empty when valid). */
export function cronIssues(cron: string): string[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return [
      `"${cron}" has ${parts.length} fields; a schedule is 5 (minute hour day-of-month month ` +
        'day-of-week), e.g. "0 8 * * 1-5" for 08:00 on weekdays',
    ];
  }
  const issues: string[] = [];
  parts.forEach((part, i) => {
    const spec = CRON_FIELDS[i] as (typeof CRON_FIELDS)[number];
    const names: readonly string[] = "names" in spec ? spec.names : [];
    const value = (text: string): number | null => {
      const upper = text.toUpperCase();
      const named = names.indexOf(upper);
      if (named >= 0) return named + (spec.name === "month" ? 1 : 0);
      if (!/^\d+$/.test(text)) return null;
      const n = Number(text);
      return n >= spec.min && n <= spec.max ? n : null;
    };
    for (const item of part.split(",")) {
      const [range, step, extra] = item.split("/");
      const bad = () =>
        issues.push(
          `Cron ${spec.name} "${part}" is not valid: use *, a number ${spec.min}-${spec.max}` +
            `${names.length ? ` or a name (${names[0]}…)` : ""}, a range a-b, a list a,b or a step */n`,
        );
      if (extra !== undefined || range === undefined || range === "") {
        bad();
        continue;
      }
      if (step !== undefined && !/^[1-9]\d*$/.test(step)) {
        bad();
        continue;
      }
      if (range === "*") continue;
      const [from, to, more] = range.split("-");
      if (more !== undefined) {
        bad();
        continue;
      }
      const a = value(from ?? "");
      const b = to === undefined ? a : value(to);
      if (a === null || b === null || b < a) bad();
    }
  });
  return issues;
}

/** Field names a filter reads. */
function filterFields(filter: ViewFilter): string[] {
  if ("and" in filter) return filter.and.flatMap(filterFields);
  if ("or" in filter) return filter.or.flatMap(filterFields);
  return [filter.field];
}

const isStageType = (match: ValueMatch | undefined): boolean =>
  typeof match === "object" && match !== null && "stageType" in match;

/**
 * A `dateRelative` trigger's minutes read per record (ADR 0570): `field` is a number field this
 * extension declares on the trigger object or one relation away, `setting` one of its number
 * settings, and each declares a `max` of at most a week, which bounds the records the host reads.
 */
function checkMomentMinutes(
  ctx: AutomationCheckContext,
  object: string | null,
  minutes: { field?: string; setting?: string },
  path: string,
): void {
  const m = ctx.manifest;
  const { contract } = ctx;
  const capped = (max: number | undefined) => max !== undefined && max <= MAX_MOMENT_MINUTES;
  if (minutes.field !== undefined) {
    const own = object?.startsWith(`${m.id}.`) ? m.objects[object.slice(m.id.length + 1)] : null;
    const field =
      own && minutes.field.split(".").length <= 2
        ? resolveFieldPath(m, own, minutes.field)
        : undefined;
    if (!own) {
      contract(
        `${path}.field`,
        "Minutes read from a field need a trigger object of this extension",
      );
    } else if (field?.type !== "number") {
      contract(
        `${path}.field`,
        `"${minutes.field}" must be a number field of ${object} or one relation away, declared by ${m.id}`,
      );
    } else if (!capped(field.max)) {
      contract(
        `${path}.field`,
        `"${minutes.field}" must declare a max of at most ${MAX_MOMENT_MINUTES}`,
      );
    }
  }
  if (minutes.setting !== undefined) {
    const setting = Object.hasOwn(m.settings ?? {}, minutes.setting)
      ? m.settings?.[minutes.setting]
      : undefined;
    if (setting?.type !== "number") {
      contract(`${path}.setting`, `"${minutes.setting}" must be a number setting of ${m.id}`);
    } else if (!capped(setting.max)) {
      contract(
        `${path}.setting`,
        `"${minutes.setting}" must declare a max of at most ${MAX_MOMENT_MINUTES}`,
      );
    }
  }
}

/**
 * True when `object` is of an extension in `onlyWith` that is not installed (no object of it is
 * `known`): what an automation running only with it names of it is checked once it is (ADR 0812).
 */
export function laterObject(
  onlyWith: readonly string[],
  known: ReadonlySet<string>,
  object: string,
): boolean {
  const ext = object.split(".")[0] as string;
  if (!object.includes(".") || !onlyWith.includes(ext)) return false;
  for (const name of known) if (name.startsWith(`${ext}.`)) return false;
  return true;
}

/** Reports problems with `automations.<name>` through `ctx.contract`. */
export function checkAutomation(
  ctx: AutomationCheckContext,
  name: string,
  automation: AutomationManifest,
): void {
  const m = ctx.manifest;
  const path = `automations.${name}`;
  const { contract } = ctx;
  const perms = m.permissions;
  const own = (object: string) => object.startsWith(`${m.id}.`);
  const canWrite = (object: string) => own(object) || perms.write.includes(object);
  const canRead = (object: string) => canWrite(object) || perms.read.includes(object);
  const trigger = automation.trigger;
  // An object of an extension the automation runs only with (ADR 0812) is unknown while that
  // extension is not installed: it is checked when it is, and the automation waits until then.
  const known = (object: string) =>
    ctx.known.has(object) || laterObject(automation.onlyWith ?? [], ctx.known, object);
  const object = triggerObject(trigger);
  const base = object !== null && Object.hasOwn(BASE_AUTOMATION_FIELDS, object);
  const fields = object && (ctx.known.has(object) || base) ? fieldsOf(ctx, object) : null;
  const ofType = (types: readonly FieldTypeName[]) =>
    Object.entries(fields ?? {})
      .filter(([, type]) => types.includes(type))
      .map(([field]) => field);

  if (!NAME_RE.test(name)) {
    contract(path, `Automation name "${name}" must be camelCase letters and digits, e.g. wonDeal`);
  }
  // 0. The extensions it runs only with: never itself, each once, none it already requires.
  (automation.onlyWith ?? []).forEach((id, i) => {
    const at = `${path}.onlyWith.${i}`;
    if (id === m.id) contract(at, "An automation of an extension always runs with it");
    else if ((automation.onlyWith ?? []).indexOf(id) !== i) contract(at, `"${id}" is listed twice`);
    else if (m.requires?.includes(id)) {
      contract(at, `The extension requires ${id}, so it is always installed: remove it here`);
    }
  });
  // 1. The trigger.
  if (base && !perms.operations.includes(`${object}.get`)) {
    contract(
      `${path}.trigger.object`,
      `An automation started by ${object} reads it: add "${object}.get" to permissions.operations`,
    );
  }
  if (object !== null && !known(object) && !base) {
    contract(
      `${path}.trigger.object`,
      `Unknown object "${object}". Use a core object (person, organisation, task, activity) or ` +
        "<extension>.<object>",
    );
  }
  const requireField = (at: string, field: string, types?: readonly FieldTypeName[]) => {
    if (!fields || !object) return;
    const type = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (type === undefined) {
      contract(at, `"${field}" is not a field of ${object} (fields: ${list(Object.keys(fields))})`);
    } else if (types && !types.includes(type)) {
      contract(
        at,
        `${object}.${field} is a ${type} field; it must be ${types.join(" or ")} ` +
          `(${types.join("/")} fields: ${list(ofType(types))})`,
      );
    }
  };
  switch (trigger.type) {
    case "record":
      if (new Set(trigger.on).size !== trigger.on.length) {
        contract(`${path}.trigger.on`, "List each record event once");
      }
      break;
    case "fieldChanged": {
      requireField(`${path}.trigger.field`, trigger.field);
      if (isStageType(trigger.from) || isStageType(trigger.to)) {
        const stages = own(trigger.object)
          ? m.objects[trigger.object.slice(m.id.length + 1)]?.stages
          : undefined;
        if (own(trigger.object) && stages?.field !== trigger.field) {
          contract(
            `${path}.trigger`,
            stages
              ? `{ stageType } compares the stage's type, so the field must be "${stages.field}" ` +
                  `(the stage field of ${trigger.object})`
              : `${trigger.object} has no stage behaviour (objects.<name>.stages); compare ` +
                  "values instead of { stageType }",
          );
        } else if (!own(trigger.object) && CORE_AUTOMATION_FIELDS[trigger.object]) {
          contract(`${path}.trigger`, `${trigger.object} has no stages; compare values instead`);
        }
      }
      if (
        trigger.from !== undefined &&
        trigger.to !== undefined &&
        JSON.stringify(trigger.from) === JSON.stringify(trigger.to)
      ) {
        contract(`${path}.trigger`, "from and to are the same, so the trigger never fires");
      }
      break;
    }
    case "schedule":
      for (const issue of cronIssues(trigger.cron)) contract(`${path}.trigger.cron`, issue);
      break;
    case "dateRelative": {
      const minutes = trigger.minutesBefore ?? trigger.minutesAfter;
      // A moment some minutes from a field is an instant: the field is a datetime (ADR 0570).
      requireField(
        `${path}.trigger.field`,
        trigger.field,
        minutes === undefined ? ["date", "datetime"] : ["datetime"],
      );
      if (trigger.zoneField !== undefined) {
        requireField(`${path}.trigger.zoneField`, trigger.zoneField, ["timezone"]);
      }
      if (minutes !== undefined && typeof minutes === "object") {
        checkMomentMinutes(
          ctx,
          object,
          minutes,
          `${path}.trigger.${trigger.minutesBefore !== undefined ? "minutesBefore" : "minutesAfter"}`,
        );
      }
      break;
    }
    case "manual":
      break;
    case "approvalDecided":
      if (trigger.operation !== undefined && !OPERATION_RE.test(trigger.operation)) {
        contract(
          `${path}.trigger.operation`,
          `"${trigger.operation}" is not an operation name, e.g. record.update`,
        );
      }
      if (trigger.object !== undefined && !known(trigger.object)) {
        contract(`${path}.trigger.object`, `Unknown object "${trigger.object}"`);
      }
      break;
    case "webhook":
      if (trigger.events && new Set(trigger.events).size !== trigger.events.length) {
        contract(`${path}.trigger.events`, "List each event type once");
      }
      break;
    case "syncEvent":
      if (!canRead("activity")) {
        contract(
          "permissions.read",
          `Automation ${name} runs on synced activities: add "activity" to permissions.read`,
        );
      }
      break;
  }

  // 1b. Connections it needs (ADR 0170): bound by a person, reached through the gatekeeper module.
  const slots = new Set<string>();
  (automation.connections ?? []).forEach((connection, i) => {
    const at = `${path}.connections.${i}`;
    if (!NAME_RE.test(connection.id)) {
      contract(`${at}.id`, `Connection id "${connection.id}" must be camelCase, e.g. mailbox`);
    }
    if (slots.has(connection.id)) {
      contract(`${at}.id`, `Connection id "${connection.id}" is declared twice`);
    }
    slots.add(connection.id);
    if (!perms.modules.includes(connection.gatekeeper)) {
      contract(
        `${at}.gatekeeper`,
        `The connection uses the ${connection.gatekeeper} gatekeeper: add "${connection.gatekeeper}" ` +
          "to permissions.modules",
      );
    }
  });

  // 2. Conditions.
  if (automation.conditions) {
    if (!object) {
      contract(
        `${path}.conditions`,
        `conditions filter the trigger record, and a ${trigger.type} trigger has none; check ` +
          "inside run instead (and declare a condition step for the diagram)",
      );
    } else if (fields) {
      for (const field of new Set(filterFields(automation.conditions))) {
        if (!Object.hasOwn(fields, field) && field !== "id") {
          contract(
            `${path}.conditions`,
            `Condition field "${field}" is not a field of ${object} (fields: ${list(Object.keys(fields))})`,
          );
        }
      }
    }
  }

  // 3. Recipients: `{ field }` / `{ managerOf }` name a user field of the trigger record.
  let notifies = false;
  const checkRecipient = (at: string, recipient: Recipient) => {
    if (typeof recipient !== "object" || "userId" in recipient) return;
    const field = "field" in recipient ? recipient.field : recipient.managerOf;
    if ("field" in recipient && (field === "admins" || field === "actor")) {
      contract(
        at,
        `Write this recipient as the plain string "${field}", not { field: "${field}" }`,
      );
      return;
    }
    if (!object) {
      contract(
        at,
        `A ${trigger.type} trigger has no trigger record, so "${field}" cannot name its user; ` +
          'use "admins" or { userId }',
      );
      return;
    }
    requireField(at, field, ["user"]);
  };

  // 4. Steps.
  const names = new Map<string, number>();
  let waitMs = 0;
  automation.steps.forEach((step, i) => {
    const at = `${path}.steps.${i}`;
    if (!NAME_RE.test(step.name)) {
      contract(`${at}.name`, `Step name "${step.name}" must be camelCase, e.g. createTasks`);
    }
    const seen = names.get(step.name);
    if (seen !== undefined) {
      contract(`${at}.name`, `Step name "${step.name}" is already used by step ${seen + 1}`);
    } else {
      names.set(step.name, i);
    }
    switch (step.kind) {
      case "sleep": {
        const ms = safeDuration(step.duration);
        if (ms === null || ms <= 0) {
          contract(`${at}.duration`, 'A sleep needs a positive duration, e.g. "3 days"');
        } else {
          waitMs += ms;
        }
        break;
      }
      case "waitForEvent": {
        if (!WAIT_EVENT_RE.test(step.event)) {
          contract(
            `${at}.event`,
            `Event type "${step.event}" may only use letters, digits, - and _ (no dots), at most 100`,
          );
        }
        const ms = safeDuration(step.timeout ?? DEFAULT_WAIT_TIMEOUT);
        if (ms === null || ms <= 0) {
          contract(`${at}.timeout`, 'A timeout needs a positive duration, e.g. "7 days"');
        } else {
          waitMs += ms;
        }
        break;
      }
      case "condition":
        break;
      default: {
        for (const read of step.reads ?? []) {
          if (!known(read)) {
            contract(`${at}.reads`, `Unknown object "${read}"`);
          } else if (!canRead(read)) {
            contract(`${at}.reads`, `Step reads ${read}: add "${read}" to permissions.read`);
          }
        }
        (step.writes ?? []).forEach((write, j) => {
          const wat = `${at}.writes.${j}`;
          if (!known(write.object)) {
            contract(`${wat}.object`, `Unknown object "${write.object}"`);
          } else if (!canWrite(write.object)) {
            contract(
              `${wat}.object`,
              `Step writes ${write.object}: add "${write.object}" to permissions.write`,
            );
          }
          if (write.titles && write.count !== undefined && write.titles.length > write.count) {
            contract(
              `${wat}.titles`,
              `${write.titles.length} titles for count ${write.count}; give at most one title per record`,
            );
          }
          if (write.assignTo) checkRecipient(`${wat}.assignTo`, write.assignTo);
        });
        (step.notifies ?? []).forEach((notify, j) => {
          notifies = true;
          checkRecipient(`${at}.notifies.${j}.to`, notify.to);
        });
        for (const call of step.calls ?? []) {
          if (!OPERATION_RE.test(call)) {
            contract(`${at}.calls`, `"${call}" is not an operation name, e.g. query.sql`);
          }
        }
      }
    }
  });
  if (waitMs > MAX_TOTAL_WAIT_DAYS * DAY_MS) {
    contract(
      `${path}.steps`,
      `The waits add up to ${Math.round(waitMs / DAY_MS)} days; one run may wait at most ` +
        `${MAX_TOTAL_WAIT_DAYS} days in total (sleeps plus waitForEvent timeouts, default ` +
        `${DEFAULT_WAIT_TIMEOUT})`,
    );
  }

  // 5. onRejected.
  const onRejected = automation.onRejected;
  if (onRejected && typeof onRejected === "object") {
    notifies = true;
    checkRecipient(`${path}.onRejected.notify`, onRejected.notify);
  }
  if (notifies && !perms.operations.includes(NOTIFY_OPERATION)) {
    contract(
      "permissions.operations",
      `Automation ${name} notifies people: add "${NOTIFY_OPERATION}" to permissions.operations`,
    );
  }
}

function safeDuration(duration: number | string): number | null {
  try {
    return durationMs(duration as Duration);
  } catch {
    return null;
  }
}
