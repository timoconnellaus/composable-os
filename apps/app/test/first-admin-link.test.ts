// The first admin's setup link (stage 66 step 9): what `cos` prints, what the sign-in page reads
// and what the host checks name the same fragment and header.
import { FIRST_ADMIN_HEADER as HOST_HEADER } from "@composable-os/auth";
import { FIRST_ADMIN_FRAGMENT as PRINTED_FRAGMENT } from "@composable-os/db/registry";
import { describe, expect, it } from "vitest";
import {
  FIRST_ADMIN_FRAGMENT,
  FIRST_ADMIN_HEADER,
  firstAdminTokenOf,
} from "../src/lib/first-admin.ts";
import { packsNotInstalled } from "../src/server/operations.ts";

describe("a client's widened packs (stage 66 step 9)", () => {
  it("are not taken as installed when the runner installed from an older list", () => {
    const results = [{ id: "ticketing" }];
    expect(packsNotInstalled("ticketing,content", results)).toEqual(["content"]);
    expect(packsNotInstalled("ticketing", results)).toEqual([]);
    expect(packsNotInstalled("*", results)).toEqual([]);
    expect(packsNotInstalled(undefined, results)).toEqual([]);
  });
});

describe("the first admin's setup link", () => {
  it("names the fragment cos prints and the header the host reads", () => {
    expect(FIRST_ADMIN_FRAGMENT).toBe(PRINTED_FRAGMENT);
    expect(FIRST_ADMIN_HEADER).toBe(HOST_HEADER);
  });

  it("reads the token from the fragment, and nothing else as one", () => {
    const token = "A".repeat(43);
    expect(firstAdminTokenOf(`#first-admin=${token}`)).toBe(token);
    expect(firstAdminTokenOf("")).toBeNull();
    expect(firstAdminTokenOf("#first-admin=short")).toBeNull();
    expect(firstAdminTokenOf(`#first-admin=${"A".repeat(40)}<script>`)).toBeNull();
  });
});
