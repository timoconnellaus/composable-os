// An erased person's full name in the booking system's own text the copy holds (class titles,
// class type names and descriptions), stage 65 step 10, ADR 0926. One rule for the erase and for a
// later timetable load that drops an erased coach:
//
// - only a full name of two words or more (one word would hit ordinary words: "Summer Bootcamp");
// - whole words, in any case and any script's capitals (É, Ö, Ł: matched in code, never by
//   SQLite's lower(), which folds ASCII only), in NFC or NFD, a straight or curly apostrophe
//   alike;
// - a hyphen is inside a word: "<name>-Smith" is a living person's double-barrelled name and is
//   left whole; "<name>'s" and "<name>’s" are the name.
// Names in a script written without spaces between words (Chinese, Japanese, Thai) have no
// second word to require, and are not matched.

/** Whether `name` is a full name the copy's text may be scrubbed of. */
export function isFullName(name: string): boolean {
  return /\S\s+\S/u.test(name.normalize("NFC").trim());
}

const WORD = "[\\p{L}\\p{N}\\p{M}-]";

/** `name` as a whole word or words, any case, NFC, either apostrophe. */
export function wholeName(name: string): RegExp {
  const escaped = name
    .normalize("NFC")
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/['’]/g, "['’]")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|(?!${WORD}).)(${escaped})(?!${WORD})`, "giu");
}

/** `text` with each of `names` replaced by `[erased]`, as whole words; null when none matched. */
export function scrubNames(text: string | null, names: readonly RegExp[]): string | null {
  if (text === null || !names.length) return null;
  const nfc = text.normalize("NFC");
  let out = nfc;
  for (const re of names) {
    re.lastIndex = 0;
    out = out.replace(re, (_m, pre: string) => `${pre}[erased]`);
  }
  return out === nfc ? null : out;
}
