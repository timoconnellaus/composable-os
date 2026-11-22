// The block lint (stage 24, acceptance criterion 12): a fixture block with a price calculation
// fails, a clean one passes, and so does every block the platform ships.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  blockFolders,
  lintBillingNames,
  lintBlocks,
  lintNoPurchase,
  lintSource,
  lintUnlisted,
} from "./check-blocks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = (name) => join(here, "fixtures", "blocks", name);

test("a block with a price calculation fails", () => {
  const problems = lintBlocks([fixture("order-summary")], root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /order-summary\.tsx:3: price-calculation: the block calculates a price/,
  );
});

test("a block that shows what the host worked out passes, words in its copy included", () => {
  assert.deepEqual(lintBlocks([fixture("clean-summary")], root), []);
});

test("a capacity check and a permission check fail too", () => {
  assert.equal(lintSource("if (event.placesLeft > 0) buy();")[0]?.rule, "capacity-check");
  assert.equal(lintSource("const canBuy = available >= quantity;")[0]?.rule, "capacity-check");
  assert.equal(lintSource('if (user.role === "admin") show();')[0]?.rule, "permission-check");
  assert.equal(lintSource("const ok = isAdmin && edit;")[0]?.rule, "permission-check");
  assert.equal(lintSource("const net = subtotal - discount;")[0]?.rule, "price-calculation");
  assert.deepEqual(lintSource('// price * 2 in a comment\nconst label = "price + tax";'), []);
});

test("every block the platform ships holds no rules", () => {
  const folders = blockFolders(root);
  assert.ok(folders.length >= 7, `found ${folders.length} blocks`);
  assert.deepEqual(lintBlocks(folders, root), []);
});

test("a noPurchase block that buys or shows a price fails (stage 42: no buying in the app)", () => {
  const problems = lintBlocks([fixture("native-buy")], root);
  assert.ok(
    problems.some((p) => /block\.json: no-purchase: the block lists x\.courses\.buy/.test(p)),
  );
  assert.ok(problems.some((p) => /buy-screen\.tsx:\d+: no-purchase/.test(p)));
  assert.equal(lintNoPurchase("const { start } = courses.useBuy();")[0]?.rule, "no-purchase");
  assert.equal(lintNoPurchase("<Text>{course.price}</Text>")[0]?.rule, "no-purchase");
  assert.deepEqual(lintNoPurchase('<Text>{"Find it on the website"}</Text>'), []);
});

test("no native block changes a subscription (stage 32a: billing on the web only)", () => {
  const marked = lintBlocks([fixture("native-cancel")], root);
  assert.ok(
    marked.some((p) => /block\.json: no-purchase: the block lists subscription\.cancel/.test(p)),
  );
  assert.ok(marked.some((p) => /cancel-screen\.tsx:\d+: no-purchase/.test(p)));
  // Not marked noPurchase: a native block is held to it all the same.
  const unmarked = lintBlocks([fixture("native-portal")], root);
  assert.ok(
    unmarked.some((p) =>
      /block\.json: native-billing: the block lists subscription\.portal/.test(p),
    ),
  );
  assert.ok(unmarked.some((p) => /portal-screen\.tsx:\d+: native-billing/.test(p)));
  assert.equal(lintNoPurchase("const go = courses.useSubscribe();")[0]?.rule, "no-purchase");
  // Reading one is allowed: the app shows the subscription.
  assert.deepEqual(lintNoPurchase("const { data } = courses.useMySubscriptions();"), []);
});

test("a billing operation named as a string, in a subfolder, and unlisted is caught", () => {
  const problems = lintBlocks([fixture("native-string")], root);
  // The string itself, read before strings are blanked, in lib/ (the lint recurses).
  assert.ok(
    problems.some((p) => /lib\/call\.ts:3: native-billing/.test(p)),
    problems.join("\n"),
  );
  // And the block's code names an operation its block.json does not list.
  assert.ok(
    problems.some((p) => /lib\/call\.ts:3: unlisted-operation: .*subscription\.cancel/.test(p)),
  );
  assert.equal(lintBillingNames('api.mutation("subscription.portal")')[0]?.rule, "native-billing");
  assert.deepEqual(lintBillingNames('api.query("subscription.list", {})'), []);
  assert.equal(
    lintUnlisted('call("x.courses.buy")', ["x.courses.course"])[0]?.rule,
    "unlisted-operation",
  );
  assert.deepEqual(lintUnlisted('call("x.courses.buy")', ["x.courses.buy"]), []);
});

test("every native bookings block is marked noPurchase, and none can buy a drop-in", async () => {
  const { readFileSync } = await import("node:fs");
  const natives = blockFolders(root).filter((dir) => /bookings-native-/.test(dir));
  assert.ok(natives.length >= 1);
  for (const dir of natives) {
    assert.equal(JSON.parse(readFileSync(join(dir, "block.json"), "utf8")).noPurchase, true, dir);
  }
  // Booking with a use already held is not a purchase; paying for a drop-in (x.bookings.buy, step
  // 8) is, and a noPurchase block may not name it, in its code or its operations.
  assert.deepEqual(lintNoPurchase('call("x.bookings.book")'), []);
  assert.equal(lintNoPurchase("const go = bookings.useBuy();")[0]?.rule, "no-purchase");
  for (const dir of natives) {
    const ops = JSON.parse(readFileSync(join(dir, "block.json"), "utf8")).operations ?? [];
    assert.ok(!ops.includes("x.bookings.buy") && !ops.includes("order.checkout"), dir);
  }
  // The web drop-in block is the one that buys.
  const dropIn = blockFolders(root).find((dir) => /bookings-drop-in$/.test(dir));
  assert.ok(dropIn);
  assert.ok(
    JSON.parse(readFileSync(join(dropIn, "block.json"), "utf8")).operations.includes(
      "x.bookings.buy",
    ),
  );
});

test("every native courses block is marked noPurchase", async () => {
  const { readFileSync } = await import("node:fs");
  const natives = blockFolders(root).filter((dir) => /courses-native-/.test(dir));
  assert.ok(natives.length >= 4);
  for (const dir of natives) {
    assert.equal(JSON.parse(readFileSync(join(dir, "block.json"), "utf8")).noPurchase, true, dir);
  }
});
