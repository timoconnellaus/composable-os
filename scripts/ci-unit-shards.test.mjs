import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageProblems, matrix, restShard, SHARDS, turboArgs } from "./ci-unit-shards.mjs";

const core = (i, n) => ({ name: `core ${i}/${n}`, group: "core", args: [`--shard=${i}/${n}`] });

test("the last shard excludes every package the others name", () => {
  const rest = restShard([{ filter: ["a"] }, { filter: ["a"] }, { filter: ["./packages/b-*"] }]);
  assert.deepEqual(rest.filter, ["!a", "!./packages/b-*"]);
  assert.equal(SHARDS.at(-1).name, "the rest");
});

test("a shard's arguments go to the test script, after turbo's", () => {
  assert.deepEqual(turboArgs({ filter: ["x"], args: ["--shard=1/2"] }), [
    "exec",
    "turbo",
    "run",
    "test",
    "--filter=x",
    "--",
    "--shard=1/2",
  ]);
  assert.deepEqual(turboArgs({ filter: ["!x"], concurrency: 2 }, { dry: true }).slice(4), [
    "--filter=!x",
    "--concurrency=2",
    "--dry=json",
  ]);
});

test("a layout where every package runs once has no problems", () => {
  const runs = [
    { shard: core(1, 2), packages: ["core"] },
    { shard: core(2, 2), packages: ["core"] },
    { shard: { name: "rest" }, packages: ["a", "b"] },
  ];
  assert.deepEqual(coverageProblems(["a", "b", "core"], runs), []);
});

test("a package in no shard fails", () => {
  const runs = [{ shard: { name: "rest" }, packages: ["a"] }];
  assert.deepEqual(coverageProblems(["a", "new"], runs), [
    "new has a test script but is in no shard",
  ]);
});

test("a package in two shards fails", () => {
  const runs = [
    { shard: { name: "one" }, packages: ["a"] },
    { shard: { name: "two" }, packages: ["a", "b"] },
  ];
  assert.match(coverageProblems(["a", "b"], runs).join(), /a is in more than one shard/);
});

test("a split package must have every part, 1/n to n/n", () => {
  const missing = [
    { shard: core(1, 3), packages: ["core"] },
    { shard: core(2, 3), packages: ["core"] },
  ];
  assert.match(coverageProblems(["core"], missing).join(), /not --shard=1\/2 to 2\/2/);
});

test("a shard that runs nothing fails", () => {
  const runs = [
    { shard: { name: "rest" }, packages: ["a"] },
    { shard: { name: "empty" }, packages: [] },
  ];
  assert.deepEqual(coverageProblems(["a"], runs), ['shard "empty" runs no tests']);
});

test("the matrix names every shard once and marks the critical ones", () => {
  assert.deepEqual(matrix([{ name: "a", critical: true }, { name: "b" }]), {
    include: [
      { shard: "a", critical: true },
      { shard: "b", critical: false },
    ],
  });
  assert.equal(matrix().include.length, SHARDS.length);
});
