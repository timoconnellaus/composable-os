// `gh attestation verify` pinned to the commit the tag names now (the re-review of #547, S2): a
// release built from a commit off main whose tag is then moved onto main must not verify.
import { VerificationError } from "@composable-os/release";
import { describe, expect, it } from "vitest";
import { type GhRun, makeGhVerifier } from "../src/gh.ts";

const BUILT_FROM = "a".repeat(40);
const MOVED_TO = "b".repeat(40);
const input = {
  bytes: new Uint8Array([1, 2, 3]),
  digest: "d",
  repository: "owner/repo",
  product: "demo",
  version: "1.2.3",
};

/** `gh` as GitHub would answer: the tag names `tagged`, the attestation was made from `built`. */
function fakeGh(tagged: string, built: string) {
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    if (args[0] === "api") return { stdout: `${tagged}\n` };
    if (args[0] === "attestation") {
      const digest = args[args.indexOf("--source-digest") + 1];
      if (args.includes("--source-digest") && digest !== built) {
        throw Object.assign(new Error("exit 1"), {
          stderr: "verification failed: source repository digest does not match",
        });
      }
      return { stdout: "" };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("gh attestation verify, pinned to the tag's commit", () => {
  it("asks which commit the tag names and passes it as --source-digest", async () => {
    const gh = fakeGh(BUILT_FROM, BUILT_FROM);
    await makeGhVerifier(gh.run)(input);
    expect(gh.calls[0]).toEqual([
      "api",
      "repos/owner/repo/commits/refs/tags/v1.2.3",
      "--jq",
      ".sha",
    ]);
    const verify = gh.calls[1] as string[];
    expect(verify.slice(0, 2)).toEqual(["attestation", "verify"]);
    expect(verify[verify.indexOf("--source-digest") + 1]).toBe(BUILT_FROM);
    expect(verify[verify.indexOf("--source-ref") + 1]).toBe("refs/tags/v1.2.3");
  });

  it("refuses a release whose tag was moved after it was built", async () => {
    const gh = fakeGh(MOVED_TO, BUILT_FROM);
    await expect(makeGhVerifier(gh.run)(input)).rejects.toThrow(VerificationError);
    await expect(makeGhVerifier(gh.run)(input)).rejects.toThrow(/digest does not match/);
  });

  it("refuses when the tag's commit cannot be read", async () => {
    const unreadable: GhRun = async (args) => {
      if (args[0] === "api") throw Object.assign(new Error("exit 1"), { stderr: "HTTP 404" });
      return { stdout: "" };
    };
    await expect(makeGhVerifier(unreadable)(input)).rejects.toThrow(/could not read the commit/);
    const odd: GhRun = async () => ({ stdout: "not-a-sha" });
    await expect(makeGhVerifier(odd)(input)).rejects.toThrow(/names no commit/);
  });
});
