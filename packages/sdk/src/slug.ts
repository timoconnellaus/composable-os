// The `slug` field type (stage 28, ADR 0442): a record's address in its object, such as
// `summer-launch` in `/blog/summer-launch`. Lowercase letters and digits in words joined by single
// hyphens. The host keeps it unique among the object's live records and makes one from the title
// when a record is created without one.

/** What a slug may be. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest a slug may be. */
export const SLUG_MAX = 120;
/** The longest slug made from a title, leaving room for a `-<n>` that tells two apart. */
export const SLUG_FROM_TITLE_MAX = 80;

/**
 * A slug made from a title: accents dropped, every run of anything that is not a letter or digit
 * a hyphen, at most SLUG_FROM_TITLE_MAX characters. Empty when nothing is left.
 */
export function slugify(title: string): string {
  const plain = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return plain.slice(0, SLUG_FROM_TITLE_MAX).replace(/-+$/g, "");
}
