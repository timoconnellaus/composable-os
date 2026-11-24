// CSV cells a spreadsheet opens safely, shared by every file the host writes for a person to
// open: the pay period's export (stage 45, ADR 0627) and the finance files (stage 52, ADR 0790).

/** A formula a spreadsheet would run: its first non-space character, the full-width ones too. */
const FORMULA_START = /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;
/** The same after a separator some spreadsheets split on (`a;=1+1` read with `;`). */
const FORMULA_AFTER_SEPARATOR = /[;,|\t\r\n]\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * A text cell a spreadsheet will not run (OWASP's CSV injection advice, widened in the review of
 * PR #287): a value whose first non-space character is `=`, `+`, `-`, `@` (or their full-width
 * forms), that starts with a tab, carriage return or line break, or that has one of them after a
 * separator, is prefixed with an apostrophe. Every text cell is quoted, quotes doubled.
 */
export function csvText(value: string | null | undefined): string {
  let v = value ?? "";
  if (FORMULA_START.test(v) || /^[\t\r\n]/.test(v) || FORMULA_AFTER_SEPARATOR.test(v)) {
    v = `'${v}`;
  }
  return `"${v.replaceAll('"', '""')}"`;
}
