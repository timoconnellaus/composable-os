// What the record editors' form models (person-draft.ts, organisation-draft.ts) share. Pure.

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
