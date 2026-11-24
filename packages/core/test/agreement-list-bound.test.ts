// agreement.list past D1's 100 bound variables a statement (ADR 0640's documents): the versions and
// points of every listed document (up to 500, retired ones included) are read at once, so their
// ids are bound as one parameter.
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
});

describe("agreement.list", () => {
  it("lists more documents than one statement may bind one by one", async () => {
    for (let n = 0; n < 101; n += 1) {
      await invoke("agreement.create", { title: unique("Bulk"), kind: "other" }, context(admin));
    }
    const listed = await invoke("agreement.list", {}, context(admin));
    expect(listed.items.length).toBeGreaterThan(100);
  }, 60_000);
});
