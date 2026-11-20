// The names the extension contract had before stage 20 (ADR 0400), when it still said `crm`.
//
// None of them is accepted: no release was installed under them, so there is nothing to keep
// working. They are listed so that code written against the old contract is refused with a
// message that names the new form, by the extension build, Code Mode, the manifest check and
// query.sql. This file is the only place the old names are written.

const OLD_PREFIX = "crm";

/** The host module extension code calls operations through, and what it was called. */
export const OPS_MODULE = "ops";
export const OLD_OPS_MODULE = OLD_PREFIX;

/** The module specifier Code Mode scripts import, and what it was. */
export const OPS_SPECIFIER = `codemode:${OPS_MODULE}`;
export const OLD_OPS_SPECIFIER = `codemode:${OLD_OPS_MODULE}`;

/** The prefix of every read view, and what it was. */
export const VIEW_PREFIX = "rec_";
export const OLD_VIEW_PREFIX = `${OLD_PREFIX}_`;

/** The core views, which were named in the plural: old suffix → new suffix. */
const RENAMED_CORE_VIEWS: Readonly<Record<string, string>> = {
  people: "person",
  organisations: "organisation",
  affiliations: "affiliation",
  activities: "activity",
  activity_links: "activity_link",
  tasks: "task",
  task_links: "task_link",
  record_tags: "record_tag",
  users: "user",
  stage_history: "stage_history",
};

/**
 * What a view named under the old contract is called now: `rec_person` for the old people view,
 * `rec_x_deals_deal` for an extension object's. Null when `name` is not an old view name.
 */
export function renamedView(name: string): string | null {
  const lower = name.toLowerCase();
  if (!lower.startsWith(OLD_VIEW_PREFIX)) return null;
  const suffix = lower.slice(OLD_VIEW_PREFIX.length);
  if (suffix.startsWith("x_")) return `${VIEW_PREFIX}${suffix}`;
  const core = RENAMED_CORE_VIEWS[suffix];
  return core ? `${VIEW_PREFIX}${core}` : null;
}

/** Why a use of an old contract name is refused, naming the new form. Null for any other name. */
export function renamedMessage(name: string): string | null {
  if (name === OLD_OPS_SPECIFIER) {
    return `"${OLD_OPS_SPECIFIER}" was renamed: import { ${OPS_MODULE} } from "${OPS_SPECIFIER}" and call ${OPS_MODULE}.call(…)`;
  }
  if (name === OLD_OPS_MODULE) {
    return `The "${OLD_OPS_MODULE}" module was renamed "${OPS_MODULE}": declare "${OPS_MODULE}" in permissions.modules and call ctx.${OPS_MODULE}`;
  }
  const view = renamedView(name);
  if (view) return `${name} was renamed ${view}; query the ${VIEW_PREFIX}* views`;
  if (name.toLowerCase().startsWith(OLD_VIEW_PREFIX)) {
    return `${name} is not a view: the ${OLD_VIEW_PREFIX}* views were renamed ${VIEW_PREFIX}*`;
  }
  return null;
}
