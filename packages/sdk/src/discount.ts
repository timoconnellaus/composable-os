// The `discount` behaviour (stage 34 step 4, ADR 0693): an object declares that its records are
// discounts (money off an order), and names the fields that say what is off, on what, for whom,
// when and how often. The host reads the record when it prices an order and enforces every rule:
// a code a buyer types, a member's price that applies by itself, one deal per order (the better
// for the buyer), and limits the database keeps under orders started at once. No caller sends an
// amount: a caller sends at most a code. Its declaration, its manifest schema and its contract
// checks live here; the host's side is packages/core/src/discounts/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";
import { moveOrigins } from "./states.ts";

/**
 * What a discount takes off: `percent` of each line it applies to (rounded down per line);
 * `amount`, money off the order, spread over the lines it applies to in proportion; `price`, a set
 * price for one of each line it applies to (a member's $15 drop-in), never above the line's own.
 */
export const DISCOUNT_KINDS = ["percent", "amount", "price"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/**
 * Who a discount is for. `anyone` includes a guest. Every other value needs a buyer who proved who
 * they are (a signed-in customer, or staff buying for a Person): a guest never qualifies, the same
 * answer for every address. `members`: the Person holds a live subscription (to one of `plans`
 * when it names any). `new_customers`: no paid order and no subscription for any Person sharing a
 * folded address with them (ADR 0692). `organisation`: the Person is currently at one of
 * `organisations`. `tag`: the Person has the tag named in `tag`.
 */
export const DISCOUNT_WHO = [
  "anyone",
  "signed_in",
  "members",
  "new_customers",
  "organisation",
  "tag",
] as const;
export type DiscountWho = (typeof DISCOUNT_WHO)[number];

/**
 * A promo code as the host keeps and compares it (ADR 0940): Unicode-normalised (NFKC), with no
 * white space and no invisible characters (zero-width spaces, soft hyphens: Unicode's default
 * ignorables), in upper case, so `été 26`, `ÉTÉ26` and `Été26` are one code, and non-ASCII letters
 * match however they are typed. The host stores a code word folded when a record is written, and
 * folds what a buyer types the same way before it looks the word up by its index. One function,
 * here, for both.
 */
export function foldCode(word: string): string {
  return word
    .normalize("NFKC")
    .replace(/[\s\p{Default_Ignorable_Code_Point}]+/gu, "")
    .toUpperCase()
    .normalize("NFKC");
}

/** The least length of a code word, in characters after folding (ADR 0940): no `SALE`, no `A1`. */
export const CODE_MIN_LENGTH = 6;
/** The longest code word (and the longest a buyer may type). */
export const CODE_MAX_LENGTH = 64;

/**
 * The letters a generated code is made of: 32, with no 0, 1, I or O, so nothing is misread and
 * each character is 5 bits exactly (no bias from the random bytes).
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * `count` random single-use codes (ADR 0940), each `length` characters of CODE_ALPHABET from
 * `crypto.getRandomValues`: 16 by default, 80 bits, which no rate of guessing reaches. Already
 * folded. For a pack's tool that makes a batch of codes; a person still approves writing them
 * (ADR 0693).
 */
export function randomCodes(count: number, length = 16): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new Error("randomCodes makes 1 to 10,000 codes");
  }
  if (!Number.isInteger(length) || length < 12 || length > CODE_MAX_LENGTH) {
    throw new Error(`A generated code is 12 to ${CODE_MAX_LENGTH} characters (60 bits or more)`);
  }
  // The Web Crypto global of every runtime the SDK runs in (Workers, browsers, Node 20+); the SDK
  // is typed without DOM or Workers types, so it is named here.
  const { crypto } = globalThis as unknown as {
    crypto: { getRandomValues(array: Uint8Array): Uint8Array };
  };
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    codes.add(Array.from(bytes, (b: number) => CODE_ALPHABET[b & 31]).join(""));
  }
  return [...codes];
}

/** What starts a code kept as its hash (`codeHash`), never the first character of a code word. */
export const CODE_HASH_PREFIX = "#";
const CODE_HASH_HEX = 56;
const CODE_HASH_PATTERN = new RegExp(`^#[0-9A-F]{${CODE_HASH_HEX}}$`);

/**
 * What a codes object declared `hashed` keeps of a code (stage 34 step 5): `#` and the first 224
 * bits of the SHA-256 of the folded code, in upper-case hex (57 characters). For codes made by
 * `randomCodes` (80 bits or more), so nobody who reads the record, the audit log or a query over
 * the views (an assistant, an MCP client) can work the code out from it; the host hashes what a
 * buyer types the same way and looks the hash up by its index. Never for a word a person chose: a
 * short word can be found from its hash by trying every word.
 */
export async function codeHash(code: string): Promise<string> {
  // The Web Crypto and encoding globals (see randomCodes).
  const { crypto, TextEncoder: Encoder } = globalThis as unknown as {
    crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
    TextEncoder: new () => { encode(text: string): Uint8Array };
  };
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Encoder().encode(foldCode(code))),
  );
  const hex = Array.from(digest, (b: number) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, CODE_HASH_HEX)
    .toUpperCase();
  return `${CODE_HASH_PREFIX}${hex}`;
}

/** Whether `value` is a code's hash as `codeHash` makes it. */
export function isCodeHash(value: string): boolean {
  return CODE_HASH_PATTERN.test(value);
}

/**
 * Codes kept as records of another object of this extension (a promo code belongs to a
 * discount): `discount` is that object's relation field (one record) to this object, `word` its
 * text field holding what the buyer types (compared without case), `uses` an optional number field
 * of the most orders one code may be used on (1: a single-use code), and `active` an optional
 * boolean field that, off, voids the code. `hashed: true` keeps each code as its hash, never the
 * code (`codeHash`): `word` then holds only hashes, which the host refuses anything else for, and
 * the codes are shown once to the person who makes them (generated single-use codes, which no
 * assistant may read).
 */
export interface DiscountCodesSpec {
  object: string;
  discount: string;
  word: string;
  uses?: string;
  active?: string;
  hashed?: boolean;
}

/**
 * Records that are discounts (ADR 0693). Every name is a field of this object.
 *
 * - `kind`: a select field whose options are among `percent`, `amount` and `price`; `percent` the
 *   number field of the percentage (0 to 100), `amount` the currency or number field of the amount
 *   off or the set price, in the currency's major unit.
 * - `live`: the states (of this object's `states`) in which the discount applies. Entering one is
 *   a person's act: every move into a live state is by `["host"]` with the tools a person makes it
 *   through, or by staff writing a state field declared `personApproves`, and nothing is created
 *   live but by the host, so an assistant's request waits for a person. The host also holds any
 *   change to a live discount by anyone but a person for a person's approval.
 * - How it applies: `automatic`, a boolean field (on: it applies by itself to whoever qualifies);
 *   `code`, a text field of one shared word; `codes`, codes kept as records of another object. At
 *   least one.
 * - `who`: a select field whose options are among DISCOUNT_WHO (left out: anyone); `plans` a
 *   relation field to plans (`members`), `organisations` one to organisations, `tag` a text field.
 * - On what: `objects`, a multi-select (or select) field whose option values are the objects it
 *   applies to (`bookings.booking`), and `records`, relation fields naming records it applies to.
 *   With neither, every line but a delivery. A line it applies to is any of either.
 * - When: `from` and `until`, date or datetime fields (a date from the start of its day through
 *   its end, UTC).
 * - Limits: `totalUses` (orders across everyone), `perPerson` (orders per Person, folded
 *   addresses counting as one), number fields; `minSpend`, a currency or number field of the least
 *   the lines it applies to must cost. A use is held from the order's start, used when it is paid,
 *   given back when it expires or is cancelled unpaid; a refund keeps it used.
 *
 * Not on an object that is sellable, has stock or a capacity: a discount is not bought.
 */
export interface DiscountSpec {
  kind: string;
  percent?: string;
  amount?: string;
  live: readonly string[];
  automatic?: string;
  code?: string;
  codes?: DiscountCodesSpec;
  who?: string;
  plans?: string;
  organisations?: string;
  tag?: string;
  objects?: string;
  records?: readonly string[];
  from?: string;
  until?: string;
  totalUses?: string;
  perPerson?: string;
  minSpend?: string;
}

const fieldName = z.string().max(40);

export const discountManifestSchema = z
  .object({
    kind: fieldName,
    percent: fieldName.optional(),
    amount: fieldName.optional(),
    live: z.array(z.string().min(1).max(100)).min(1).max(10),
    automatic: fieldName.optional(),
    code: fieldName.optional(),
    codes: z
      .object({
        object: fieldName,
        discount: fieldName,
        word: fieldName,
        uses: fieldName.optional(),
        active: fieldName.optional(),
        hashed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    who: fieldName.optional(),
    plans: fieldName.optional(),
    organisations: fieldName.optional(),
    tag: fieldName.optional(),
    objects: fieldName.optional(),
    records: z.array(fieldName).min(1).max(5).optional(),
    from: fieldName.optional(),
    until: fieldName.optional(),
    totalUses: fieldName.optional(),
    perPerson: fieldName.optional(),
    minSpend: fieldName.optional(),
  })
  .strict();
export type DiscountManifest = z.infer<typeof discountManifestSchema>;

const NUMBER: readonly string[] = ["number", "percent"];
const MONEY: readonly string[] = ["currency", "number"];
const WHEN: readonly string[] = ["date", "datetime"];

/** Reports problems with `objects.<name>.discount` through `contract`. */
export function checkObjectDiscount(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const discount = object.discount;
  if (!discount) return;
  const path = `objects.${name}.discount`;
  const fieldOf = (owner: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(owner.fields, local) ? owner.fields[local] : undefined;
  const single = (field: FieldManifest | undefined, types: readonly string[]) =>
    field !== undefined && types.includes(field.type) && !field.many;
  const need = (
    key: keyof DiscountSpec,
    local: string | undefined,
    types: readonly string[],
    words: string,
  ) => {
    if (local === undefined) return;
    if (!single(fieldOf(object, local), types)) {
      contract(`${path}.${key}`, `"${local}" must be ${words} field of ${name}`);
    }
  };
  /** The option values of a select field of this object, or null when it is not one. */
  const optionsOf = (local: string, multi: boolean): string[] | null => {
    const field = fieldOf(object, local);
    const ok = field?.type === "select" || (multi && field?.type === "multiSelect");
    return ok ? (field?.options ?? []).map((o) => o.value) : null;
  };

  // What is off.
  const kinds = optionsOf(discount.kind, false);
  if (!kinds) {
    contract(`${path}.kind`, `"${discount.kind}" must be a select field of ${name}`);
  } else {
    for (const value of kinds) {
      if (!(DISCOUNT_KINDS as readonly string[]).includes(value)) {
        contract(
          `${path}.kind`,
          `"${value}" is not a kind of discount: the options of ${discount.kind} are among ${DISCOUNT_KINDS.join(", ")}`,
        );
      }
    }
    if (kinds.includes("percent") && discount.percent === undefined) {
      contract(
        `${path}.percent`,
        "A percentage discount needs percent: the field of its percentage",
      );
    }
    if ((kinds.includes("amount") || kinds.includes("price")) && discount.amount === undefined) {
      contract(`${path}.amount`, "An amount or a set price needs amount: the field of the money");
    }
  }
  need("percent", discount.percent, NUMBER, "a number or percent");
  need("amount", discount.amount, MONEY, "a currency or number");

  // How it applies.
  if (
    discount.automatic === undefined &&
    discount.code === undefined &&
    discount.codes === undefined
  ) {
    contract(
      path,
      "Say how the discount applies: automatic (a boolean field), code (a text field) or codes (records of another object)",
    );
  }
  need("automatic", discount.automatic, ["boolean"], "a boolean");
  need("code", discount.code, ["text"], "a text");
  if (discount.codes) {
    const codes = discount.codes;
    const cp = `${path}.codes`;
    const owner = Object.hasOwn(m.objects, codes.object) ? m.objects[codes.object] : undefined;
    if (!owner || codes.object === name) {
      contract(`${cp}.object`, `"${codes.object}" must be another object of this extension`);
    } else {
      const relation = fieldOf(owner, codes.discount);
      if (relation?.type !== "relation" || relation.many || relation.to !== `${m.id}.${name}`) {
        contract(
          `${cp}.discount`,
          `"${codes.discount}" must be a relation field (one record) of ${codes.object} to ${m.id}.${name}`,
        );
      }
      if (!single(fieldOf(owner, codes.word), ["text"])) {
        contract(`${cp}.word`, `"${codes.word}" must be a text field of ${codes.object}`);
      }
      if (codes.uses !== undefined && !single(fieldOf(owner, codes.uses), ["number"])) {
        contract(`${cp}.uses`, `"${codes.uses}" must be a number field of ${codes.object}`);
      }
      if (codes.active !== undefined && !single(fieldOf(owner, codes.active), ["boolean"])) {
        contract(`${cp}.active`, `"${codes.active}" must be a boolean field of ${codes.object}`);
      }
      if (owner.sellable || owner.discount) {
        contract(`${cp}.object`, `${codes.object} holds codes: it is not sold and not a discount`);
      }
    }
  }

  // For whom.
  if (discount.who !== undefined) {
    const who = optionsOf(discount.who, false);
    if (!who) {
      contract(`${path}.who`, `"${discount.who}" must be a select field of ${name}`);
    } else {
      for (const value of who) {
        if (!(DISCOUNT_WHO as readonly string[]).includes(value)) {
          contract(
            `${path}.who`,
            `"${value}" is not who a discount is for: the options of ${discount.who} are among ${DISCOUNT_WHO.join(", ")}`,
          );
        }
      }
      if (who.includes("tag") && discount.tag === undefined) {
        contract(`${path}.tag`, "A discount for a tag needs tag: the text field naming it");
      }
      if (who.includes("organisation") && discount.organisations === undefined) {
        contract(
          `${path}.organisations`,
          "A discount for an organisation needs organisations: the relation field naming them",
        );
      }
    }
  }
  const relation = (local: string | undefined) =>
    local === undefined ? undefined : fieldOf(object, local);
  if (discount.plans !== undefined) {
    const field = relation(discount.plans);
    if (field?.type !== "relation") {
      contract(`${path}.plans`, `"${discount.plans}" must be a relation field to a plan`);
    }
  }
  if (discount.organisations !== undefined) {
    const field = relation(discount.organisations);
    if (field?.type !== "relation" || field.to !== "organisation") {
      contract(
        `${path}.organisations`,
        `"${discount.organisations}" must be a relation field to organisation`,
      );
    }
  }
  need("tag", discount.tag, ["text"], "a text");

  // On what.
  if (discount.objects !== undefined && !optionsOf(discount.objects, true)) {
    contract(
      `${path}.objects`,
      `"${discount.objects}" must be a multi-select or select field of ${name} whose option values are objects`,
    );
  }
  for (const [i, local] of (discount.records ?? []).entries()) {
    if (relation(local)?.type !== "relation") {
      contract(`${path}.records.${i}`, `"${local}" must be a relation field of ${name}`);
    }
  }

  // When, and how often.
  need("from", discount.from, WHEN, "a date or datetime");
  need("until", discount.until, WHEN, "a date or datetime");
  need("totalUses", discount.totalUses, ["number"], "a number");
  need("perPerson", discount.perPerson, ["number"], "a number");
  need("minSpend", discount.minSpend, MONEY, "a currency or number");

  for (const key of ["sellable", "stock", "capacity"] as const) {
    if (object[key] !== undefined) {
      contract(`objects.${name}.${key}`, `A discount is not bought or counted: it has no ${key}`);
    }
  }

  // Live states, entered only by a person (an AI's request waits), as stock moves are (ADR 0681).
  const states = object.states;
  if (!states) {
    contract(`${path}.live`, `${name} must declare states: live names the states it applies in`);
    return;
  }
  const stateField = fieldOf(object, states.field);
  const values = new Set((stateField?.options ?? []).map((o) => o.value));
  for (const live of discount.live) {
    if (!values.has(live)) contract(`${path}.live`, `"${live}" is not a state of ${name}`);
  }
  const liveSet = new Set(discount.live);
  if (liveSet.has(states.initial)) {
    contract(
      `${path}.live`,
      `"${states.initial}" is where a new discount starts: a discount is made in another state and moved live by a person`,
    );
  }
  // A person moves it live: through a tool a person makes the move with (a shipped pack, whose
  // tools declare a permission), or by staff writing a state field a person approves (any
  // extension: anyone else's write of it waits for a person, ADR 0507). Never a customer.
  const personField = stateField?.personApproves === true;
  states.moves.forEach((move, i) => {
    if (!liveSet.has(move.to)) return;
    // A move between two live states (active to paused and back) changes nothing a buyer gets.
    if (moveOrigins(move).every((from) => liveSet.has(from))) return;
    const byTool = move.by.every((mover) => mover === "host");
    const byPerson = personField && move.by.every((mover) => mover !== "customer");
    if (!byTool && !byPerson) {
      contract(
        `objects.${name}.states.moves.${i}.by`,
        `Entering "${move.to}" makes a discount apply: declare it by ["host"] with the tools a person makes it through (states.moves.<n>.tools), or by ["staff"] with a state field a person approves (fields.${states.field}.personApproves)`,
      );
    }
  });
  for (const live of discount.live) {
    const created = states.create?.in?.[live];
    if (created?.some((mover) => mover !== "host")) {
      contract(
        `objects.${name}.states.create.in.${live}`,
        `Creating a discount in "${live}" makes it apply: only the host may; create it in another state and move it through a tool`,
      );
    }
  }
  // Past its first state a discount's terms are changed only by a person (ADR 0699): nothing but
  // the host creates one past it, and nothing but the host (a person's tool) moves one back to it,
  // so there is no way round that rule.
  for (const [state, movers] of Object.entries(states.create?.in ?? {})) {
    if (state === states.initial || liveSet.has(state)) continue;
    if (movers.some((mover) => mover !== "host")) {
      contract(
        `objects.${name}.states.create.in.${state}`,
        `A discount is made in "${states.initial}": past it, its terms are a person's to change, so only the host may create one in "${state}"`,
      );
    }
  }
  states.moves.forEach((move, i) => {
    if (move.to !== states.initial) return;
    if (move.by.some((mover) => mover !== "host")) {
      contract(
        `objects.${name}.states.moves.${i}.by`,
        `Moving a discount back to "${states.initial}" would make its terms anyone's to change again: declare it by ["host"] with a person's tool, or leave it out`,
      );
    }
  });
}
