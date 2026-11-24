// The `stock` behaviour (stage 37, ADR 0680): an object declares that its records are things
// counted on a shelf (a variant of an item in a shop), and the host keeps how many there are, from
// a ledger nobody edits, never selling more than there is, for every actor. Its declaration, its
// manifest schema and its contract checks live here; the host's side is packages/core/src/stock/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";
import { moveOrigins } from "./states.ts";

/**
 * What customers and the public are told about a record's stock (staff always see the numbers):
 * `availability` (the default), "In stock" or "Sold out"; `low`, "only N left" at or below
 * `lowAt`; `exact`, the number available.
 */
export const STOCK_SHOW = ["exact", "low", "availability"] as const;
export type StockShow = (typeof STOCK_SHOW)[number];

/**
 * The read-only values the host adds to every record of an object with stock: on hand (what is
 * on the shelf, sold units gone), held (by orders being paid for) and available (on hand less
 * held). An object with stock cannot have fields of these names.
 */
export const STOCK_VALUES = ["onHand", "held", "available"] as const;

/**
 * The kinds of movement in the ledger (ADR 0680). The host writes `opening`, `adjusted` and
 * `sold`; a record's `stockMoves` writes `received`, `written_off`, `used` and `counted` (ADR
 * 0681); a return (stage 37 step 4) writes `returned`.
 */
export const STOCK_MOVEMENT_KINDS = [
  "opening",
  "received",
  "sold",
  "returned",
  "written_off",
  "counted",
  "adjusted",
  "used",
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * A number of things on hand (ADR 0680). The host keeps the count from a ledger of movements
 * (opening stock, a correction, a sale) and nobody types it: an order line holds its quantity
 * while the order is unpaid and sells it when it is paid, refused by the database past what is
 * available, in the order's own batch. A refund changes nothing in stock; a return does.
 *
 * - `reorderAt` is this object's number field holding the reorder level (a record at or below it
 *   is low); `reorderQty` the number field holding how many to order then.
 * - `show` is what customers and the public are told (default `availability`); `lowAt` is the
 *   threshold for `low`.
 * - `notify` is one of this extension's tool permissions: when a write takes a record's on hand to
 *   or below its reorder level, the staff who hold it are told, once until it rises above again
 *   (ADR 0681). Without it, the admins are told. It needs `reorderAt`.
 * - The object is sellable, or the object a `stockMoves` of this extension moves (a part nobody
 *   sells still has stock).
 *
 * An object with stock is not also a capacity (its counter is the stock's), and is not bought by
 * deposit, by subscription or by moving a record (`sellable.deposit`, `recurring`, `moves`).
 */
export interface StockSpec {
  reorderAt?: string;
  reorderQty?: string;
  show?: StockShow;
  lowAt?: number;
  notify?: string;
}

const fieldName = z.string().max(40);

export const stockManifestSchema = z
  .object({
    reorderAt: fieldName.optional(),
    reorderQty: fieldName.optional(),
    show: z.enum(STOCK_SHOW).optional(),
    lowAt: z.number().int().min(1).max(1_000_000).optional(),
    notify: z.string().max(80).optional(),
  })
  .strict();
export type StockManifest = z.infer<typeof stockManifestSchema>;

/** Reports problems with `objects.<name>.stock` through `contract`. */
export function checkObjectStock(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const stock = object.stock;
  if (!stock) return;
  const path = `objects.${name}.stock`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  for (const key of ["reorderAt", "reorderQty"] as const) {
    const local = stock[key];
    if (local === undefined) continue;
    const field = fieldOf(local);
    if (field?.type !== "number" || field.many) {
      contract(`${path}.${key}`, `"${local}" must be a number field of ${name}`);
    }
  }
  for (const reserved of STOCK_VALUES) {
    if (Object.hasOwn(object.fields, reserved)) {
      contract(
        `objects.${name}.fields.${reserved}`,
        `"${reserved}" is a value the host adds to an object with stock; rename the field`,
      );
    }
  }
  if (object.capacity) {
    contract(path, "An object has stock or a capacity, not both: stock keeps its own counter");
  }
  const sellable = object.sellable;
  if (sellable) {
    for (const key of ["deposit", "recurring", "moves"] as const) {
      if (sellable[key] !== undefined) {
        contract(
          `objects.${name}.sellable.${key}`,
          `A thing in stock is sold whole, on an order: it has no sellable.${key}`,
        );
      }
    }
  }
  if (stock.lowAt !== undefined && stock.show !== "low") {
    contract(`${path}.lowAt`, 'lowAt is the threshold of show: "low"');
  }
  if (stock.show === "low" && stock.lowAt === undefined) {
    contract(`${path}.lowAt`, 'show: "low" needs lowAt, the number at or below which it says so');
  }
  if (stock.notify !== undefined) {
    if (stock.reorderAt === undefined) {
      contract(`${path}.notify`, "notify tells staff of a reorder level: declare reorderAt");
    }
    const permissions = Object.values(m.tools).flatMap((tool) =>
      typeof tool.permission === "string" ? [tool.permission] : [...(tool.permission ?? [])],
    );
    if (!permissions.includes(stock.notify)) {
      contract(
        `${path}.notify`,
        `"${stock.notify}" is not the permission of any of this extension's tools (tools.<name>.permission)`,
      );
    }
  }
  const moved = Object.values(m.objects).some(
    (other) => other.stockMoves && relationTarget(m, other, other.stockMoves.on) === name,
  );
  if (!sellable && !moved) {
    contract(
      path,
      `${name} has stock but is neither sellable nor moved by a stockMoves of this extension`,
    );
  }
}

// --- stockMoves (ADR 0681) ------------------------------------------------------------------------

/** How a record's move changes stock: units in, units out, or on hand set to a counted number. */
export const STOCK_MOVES = ["add", "remove", "set"] as const;
export type StockMove = (typeof STOCK_MOVES)[number];

/** The ledger kinds each move may write; the first is the default. */
export const STOCK_MOVE_KINDS = {
  add: ["received"],
  remove: ["written_off", "used"],
  set: ["counted"],
} as const satisfies Record<StockMove, readonly StockMovementKind[]>;

/**
 * A record's state moves stock (ADR 0681): when it enters `when`, the host writes a movement of
 * `quantity` on the record `on` points to (an object of this extension with stock), in the batch
 * of the write that makes the move, for every actor. A receipt `received` adds; a write-off
 * removes; a count line `set`s on hand to the number counted, the difference worked out when the
 * batch commits.
 *
 * - `when` is a state of this object, or with `through`, of the record `through` points to (a
 *   relation, one record, to another object of this extension with states): that record entering
 *   `when` moves the stock of every live record of this object pointing to it, in one batch (a
 *   count applied moves each of its lines). No declared move leaves `when`: stock moves once.
 * - `kind` is the ledger's kind: `received` for add; `written_off` (default) or `used` for
 *   remove; `counted` for set.
 * - `unitCost` (add only) is a number field of the cost of one, in minor units; `note` a text
 *   field the ledger keeps.
 * - Every declared move into `when` is by `["host"]`, with the `tools` (humanOnly or
 *   personApproves, with a permission) a person makes it through; nothing is created in `when`
 *   but by the host. Moving stock is a person's act: an AI's call of the tool waits for a person.
 * - A quantity is a whole number, above 0 (add, remove) or 0 and above (set). Once moved, `on`,
 *   `quantity`, `unitCost` and `note` cannot change, and a moved record's lines cannot be added to
 *   or changed: the ledger keeps what moved.
 */
export interface StockMovesSpec {
  move: StockMove;
  on: string;
  quantity: string;
  when: string;
  through?: string;
  kind?: StockMovementKind;
  unitCost?: string;
  note?: string;
}

export const stockMovesManifestSchema = z
  .object({
    move: z.enum(STOCK_MOVES),
    on: fieldName,
    quantity: fieldName,
    when: z.string().min(1).max(100),
    through: fieldName.optional(),
    kind: z.enum(STOCK_MOVEMENT_KINDS).optional(),
    unitCost: fieldName.optional(),
    note: fieldName.optional(),
  })
  .strict();
export type StockMovesManifest = z.infer<typeof stockMovesManifestSchema>;

/** The local name of the object of this extension a one-record relation field points to. */
function relationTarget(
  m: ExtensionManifest,
  object: ObjectManifest,
  field: string,
): string | undefined {
  const f = Object.hasOwn(object.fields, field) ? object.fields[field] : undefined;
  if (f?.type !== "relation" || f.many || !f.to?.startsWith(`${m.id}.`)) return undefined;
  const local = f.to.slice(m.id.length + 1);
  return Object.hasOwn(m.objects, local) ? local : undefined;
}

/** Reports problems with `objects.<name>.stockMoves` through `contract`. */
export function checkObjectStockMoves(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const moves = object.stockMoves;
  if (!moves) return;
  const path = `objects.${name}.stockMoves`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const target = relationTarget(m, object, moves.on);
  if (!target) {
    contract(
      `${path}.on`,
      `"${moves.on}" must be a relation field (one record) to an object of this extension with stock`,
    );
  } else if (!m.objects[target]?.stock) {
    contract(`${path}.on`, `${m.id}.${target} must declare stock for its stock to move`);
  }
  const number = (key: "quantity" | "unitCost") => {
    const local = moves[key];
    if (local === undefined) return;
    const field = fieldOf(local);
    if (field?.type !== "number" || field.many) {
      contract(`${path}.${key}`, `"${local}" must be a number field of ${name}`);
    }
  };
  number("quantity");
  number("unitCost");
  if (moves.unitCost !== undefined && moves.move !== "add") {
    contract(`${path}.unitCost`, "Only what comes in (add) has a unit cost");
  }
  if (moves.note !== undefined) {
    const field = fieldOf(moves.note);
    if (field?.type !== "text" || field.many) {
      contract(`${path}.note`, `"${moves.note}" must be a text field of ${name}`);
    }
  }
  const kinds: readonly string[] = STOCK_MOVE_KINDS[moves.move];
  if (moves.kind !== undefined && !kinds.includes(moves.kind)) {
    contract(
      `${path}.kind`,
      `A ${moves.move} writes ${kinds.map((k) => `"${k}"`).join(" or ")}, not "${moves.kind}"`,
    );
  }
  // Whose state moves it: this object's, or the record `through` points to.
  let owner: string | undefined = name;
  if (moves.through !== undefined) {
    owner = relationTarget(m, object, moves.through);
    if (!owner || owner === name) {
      contract(
        `${path}.through`,
        `"${moves.through}" must be a relation field (one record) to another of this extension's objects`,
      );
      return;
    }
  }
  const states = m.objects[owner]?.states;
  if (!states) {
    contract(
      moves.through === undefined ? path : `${path}.through`,
      `${owner} must declare states: entering "${moves.when}" moves the stock`,
    );
    return;
  }
  const stateField = Object.hasOwn(m.objects[owner]?.fields ?? {}, states.field)
    ? m.objects[owner]?.fields[states.field]
    : undefined;
  if (!(stateField?.options ?? []).some((o) => o.value === moves.when)) {
    contract(`${path}.when`, `"${moves.when}" is not a state of ${owner}`);
  }
  if (states.moves.some((move) => moveOrigins(move).includes(moves.when))) {
    contract(
      `${path}.when`,
      `No move may leave "${moves.when}": stock moves once, when a record enters it`,
    );
  }
  // Moving stock is a person's act with the pack's permission (ADR 0681, the review of #422):
  // the host's alone, and the tools a person calls (ADR 0513), so an assistant's or an MCP
  // client's call of them waits for a person, and no customer, member or automation moves stock
  // by moving a record.
  states.moves.forEach((move, i) => {
    if (move.to !== moves.when) return;
    if (move.by.some((mover) => mover !== "host")) {
      contract(
        `objects.${owner}.states.moves.${i}.by`,
        `Entering "${moves.when}" moves stock: declare it by ["host"] with the tools a person makes it through (states.moves.<n>.tools)`,
      );
    }
  });
  const created = states.create?.in?.[moves.when];
  if (created?.some((mover) => mover !== "host")) {
    contract(
      `objects.${owner}.states.create.in.${moves.when}`,
      `Creating a record in "${moves.when}" moves stock: only the host may; create it in another state and move it through a tool`,
    );
  }
}
