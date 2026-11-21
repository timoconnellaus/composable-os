// The block lint (stage 24, acceptance criterion 12): a fixture block with a price calculation
// fails, a clean one passes, and so does every block the platform ships.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { blockFolders, lintBlocks, lintNoPurchase, lintSource } from "./check-blocks.mjs";

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
  assert.ok(problems.some((p) => /block\.json: no-purchase: the block lists x\.courses\.buy/.test(p)));
  assert.ok(problems.some((p) => /buy-screen\.tsx:\d+: no-purchase/.test(p)));
  assert.equal(lintNoPurchase("const { start } = courses.useBuy();")[0]?.rule, "no-purchase");
  assert.equal(lintNoPurchase("<Text>{course.price}</Text>")[0]?.rule, "no-purchase");
  assert.deepEqual(lintNoPurchase('<Text>{"Find it on the website"}</Text>'), []);
});

test("every native courses block is marked noPurchase", async () => {
  const { readFileSync } = await import("node:fs");
  const natives = blockFolders(root).filter((dir) => /courses-native-/.test(dir));
  assert.ok(natives.length >= 4);
  for (const dir of natives) {
    assert.equal(JSON.parse(readFileSync(join(dir, "block.json"), "utf8")).noPurchase, true, dir);
  }
});
