// The content import's interchange format (ADR 0470, docs/importing.md): a folder of posts, one
// JSON file each, and their pictures. Read and checked here with no network and no file system:
// the CLI hands in the files, and every problem comes back with the file it is in, before anything
// is written anywhere.
//
//   <folder>/
//     <any name>.json     one post each (the file name without .json is its import key)
//     pictures/<file>     the pictures the posts name
//
// A post's fields are the platform's own shapes (`content.post`), with a picture named by its
// file where the stored shape has a media id: `"file": "hall.jpg"` in a rich text image block, and
// `{ "file", "alt", "focal"? }` for the cover and the share picture. The category is its name.
import {
  IMAGE_SCHEMA,
  mediaProblem,
  RICH_TEXT_SCHEMA,
  SLUG_MAX,
  SLUG_RE,
  slugify,
  validateDocument,
} from "@composable-os/sdk";
import { isObject, type Problem, replaceMarked } from "../import-door/records.ts";

export const FORMAT_VERSION = 1;
export const POST_OBJECT = "content.post";
export const CATEGORY_OBJECT = "content.category";
export const STATUSES = ["draft", "scheduled", "published"] as const;
export type Status = (typeof STATUSES)[number];

/** The fields a post file may have, and what each is. */
export const POST_FIELDS: Readonly<Record<string, string>> = {
  key: "the post's import key (default: the file's name without .json)",
  title: "text, required",
  slug: "the address: lowercase words joined by hyphens (default: made from the title)",
  excerpt: "text",
  body: "rich text (RICH_TEXT_SCHEMA), a picture named by `file` where it has `media`",
  cover: "{ file, alt, focal? }",
  date: "ISO 8601 date and time: the date readers are shown, kept when published",
  status: "draft | scheduled | published (default draft)",
  category: "the category's name",
  byline: "text: who wrote it, as readers see it",
  seoTitle: "text",
  seoDescription: "text",
  seoImage: "{ file, alt, focal? }",
  noindex: "true to ask search engines not to list it",
};

export type { Problem };

/** A picture's place in the values, until it is uploaded and has an id. */
export const PICTURE = "$picture";

export interface PlannedPost {
  file: string;
  key: string;
  status: Status;
  date: string | null;
  /** The record's values, with `{ $picture: <file> }` where a media id goes. */
  values: Record<string, unknown>;
  /** The category's import key, when the post has one. */
  category: string | null;
  pictures: string[];
}

export interface PlannedCategory {
  key: string;
  values: { name: string; slug: string };
}

export interface ImportPlan {
  posts: PlannedPost[];
  categories: PlannedCategory[];
  /** File name in pictures/ → bytes, of the pictures the posts name. */
  pictures: Map<string, Uint8Array>;
  problems: Problem[];
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Every `{ $picture }` in a value replaced by `id(file)`. */
export function withPictures(value: unknown, id: (file: string) => string): unknown {
  return replaceMarked(value, PICTURE, id);
}

/** A placeholder media id of the right shape, for checking a post before its pictures exist. */
export const placeholderMedia = (index: number) => `med_import${index}`;

/**
 * The folder as an import: each post's values in the platform's shapes, the categories they
 * name, the pictures they use, and every problem with its file.
 */
export function readFolder(files: {
  posts: Map<string, string>;
  pictures: Map<string, Uint8Array>;
}): ImportPlan {
  const problems: Problem[] = [];
  const posts: PlannedPost[] = [];
  const categories = new Map<string, PlannedCategory>();
  const used = new Map<string, Uint8Array>();
  const keys = new Map<string, string>();
  const slugs = new Map<string, string>();
  const picturesProblems = new Set<string>();

  for (const [file, text] of [...files.posts].sort(([a], [b]) => a.localeCompare(b))) {
    const fault = (message: string) => problems.push({ file, message });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      fault(`Not JSON: ${(error as Error).message}`);
      continue;
    }
    if (!isObject(raw)) {
      fault("A post is a JSON object");
      continue;
    }
    for (const name of Object.keys(raw)) {
      if (!Object.hasOwn(POST_FIELDS, name)) {
        fault(`Unknown field "${name}" (${Object.keys(POST_FIELDS).join(", ")})`);
      }
    }
    const key = typeof raw.key === "string" ? raw.key : file.replace(/\.json$/i, "");
    if (!KEY_RE.test(key)) fault(`The key "${key}" is not 1 to 200 letters, digits or ._:-`);
    const other = keys.get(key);
    if (other) fault(`The key "${key}" is ${other}'s too`);
    keys.set(key, file);

    const values: Record<string, unknown> = {};
    const pictures: string[] = [];
    const text_ = (name: string, max: number, required = false) => {
      const v = raw[name];
      if (v === undefined || v === null) {
        if (required) fault(`${name} is required`);
        return;
      }
      if (typeof v !== "string" || (required && !v.trim())) fault(`${name} is text`);
      else if (v.length > max) fault(`${name} is at most ${max} characters`);
      else values[name] = v;
    };
    text_("title", 1000, true);
    text_("excerpt", 1000);
    text_("byline", 1000);
    text_("seoTitle", 1000);
    text_("seoDescription", 1000);

    if (raw.slug !== undefined) {
      if (typeof raw.slug !== "string" || raw.slug.length > SLUG_MAX || !SLUG_RE.test(raw.slug)) {
        fault("slug is lowercase letters and digits in words joined by hyphens");
      } else {
        values.slug = raw.slug;
      }
    }
    const slug = (values.slug as string | undefined) ?? slugify(String(raw.title ?? ""));
    if (slug) {
      const holder = slugs.get(slug);
      if (holder) fault(`The address "${slug}" is ${holder}'s too`);
      slugs.set(slug, file);
    }

    const picture = (given: unknown, path: string) => {
      if (typeof given !== "string" || !given || given.includes("/") || given.includes("\\")) {
        fault(`${path}: a picture is a file name in pictures/`);
        return null;
      }
      const bytes = files.pictures.get(given);
      if (!bytes) {
        fault(`${path}: pictures/${given} is not there`);
        return null;
      }
      const problem = mediaProblem(bytes);
      if (problem) {
        if (!picturesProblems.has(given))
          problems.push({ file: `pictures/${given}`, message: problem });
        picturesProblems.add(given);
        fault(`${path}: pictures/${given} cannot be uploaded`);
        return null;
      }
      used.set(given, bytes);
      pictures.push(given);
      return { [PICTURE]: given };
    };

    for (const name of ["cover", "seoImage"] as const) {
      const v = raw[name];
      if (v === undefined || v === null) continue;
      if (!isObject(v)) {
        fault(`${name} is { file, alt, focal? }`);
        continue;
      }
      const { file: pictureFile, ...rest } = v;
      const ref = picture(pictureFile, name);
      const candidate = { media: placeholderMedia(0), ...rest };
      const checked = validateDocument(IMAGE_SCHEMA, candidate);
      if (!checked.ok) {
        for (const issue of checked.issues) {
          fault(`${name}.${issue.path.join(".")}: ${issue.message}`);
        }
        continue;
      }
      if (ref) values[name] = { ...rest, media: ref };
    }

    if (raw.body !== undefined && raw.body !== null) {
      let n = 0;
      const placed: unknown = JSON.parse(JSON.stringify(raw.body), function (this: unknown, _k, v) {
        // A rich text picture: `file` where the stored shape has `media`.
        if (isObject(v) && v.type === "image" && typeof v.file === "string" && !("media" in v)) {
          const { file: f, ...rest } = v;
          const ref = picture(f, `body (picture ${f})`);
          n += 1;
          return { ...rest, media: ref ?? placeholderMedia(n) };
        }
        return v;
      });
      const check = withPictures(placed, () => placeholderMedia(0));
      const checked = validateDocument(RICH_TEXT_SCHEMA, check, { maxBytes: 524_288 });
      if (!checked.ok) {
        for (const issue of checked.issues) {
          fault(`body.${issue.path.join(".")}: ${issue.message}`);
        }
      } else {
        values.body = placed;
      }
    }

    let date: string | null = null;
    if (raw.date !== undefined && raw.date !== null) {
      if (
        typeof raw.date !== "string" ||
        !DATETIME_RE.test(raw.date) ||
        Number.isNaN(Date.parse(raw.date))
      ) {
        fault("date is an ISO 8601 date and time, with its zone (2024-05-01T09:00:00Z)");
      } else {
        date = new Date(raw.date).toISOString();
        values.date = date;
      }
    }
    const status = (raw.status ?? "draft") as Status;
    if (!STATUSES.includes(status)) fault(`status is one of ${STATUSES.join(", ")}`);
    if (status === "scheduled" && !date) fault("A scheduled post has the date it goes live");
    if (raw.noindex !== undefined) {
      if (typeof raw.noindex !== "boolean") fault("noindex is true or false");
      else values.noindex = raw.noindex;
    }

    let category: string | null = null;
    if (raw.category !== undefined && raw.category !== null) {
      const name = typeof raw.category === "string" ? raw.category.trim() : "";
      const categorySlug = slugify(name);
      if (!name || !categorySlug || name.length > 1000) fault("category is the category's name");
      else {
        category = `category:${categorySlug}`;
        if (!categories.has(category)) {
          categories.set(category, { key: category, values: { name, slug: categorySlug } });
        }
      }
    }
    posts.push({ file, key, status, date, values, category, pictures });
  }
  return { posts, categories: [...categories.values()], pictures: used, problems };
}
