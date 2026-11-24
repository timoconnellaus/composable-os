// What the form models (person-draft.ts, organisation-draft.ts, the settings forms) share. Pure.

/** Exactly one primary among the kept rows: the flagged one, else the first. */
export function withOnePrimary<T extends { primary: boolean }>(rows: T[]): T[] {
  const index = Math.max(
    0,
    rows.findIndex((row) => row.primary),
  );
  return rows.map((row, i) => ({ ...row, primary: i === index }));
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Trimmed text, or null when blank (blank clears the field). */
export const orNull = (value: string) => (value.trim() ? value.trim() : null);

/**
 * A field as the form shows it: the draft's value when the field was changed, even to null or
 * undefined ("Off"), else the saved one.
 */
export function drafted<T extends object, K extends keyof T>(
  draft: Partial<T>,
  saved: T | undefined,
  key: K,
): T[K] | undefined {
  return key in draft ? draft[key] : saved?.[key];
}
