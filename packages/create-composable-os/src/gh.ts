// Full Sigstore verification with the GitHub CLI (`gh attestation verify`), when `gh` is
// installed: certificate chain to Sigstore's root, transparency log, the signer workflow at this
// version's tag, and the commit that tag names now. The library's own check (GitHub's attestation
// store) always runs too.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExtraVerifier, releaseAssetNames, VerificationError } from "@composable-os/release";

const exec = promisify(execFile);

/** Runs `gh` with `args`, its standard output returned (a stand-in in tests). */
export type GhRun = (args: string[]) => Promise<{ stdout: string }>;

const runGh: GhRun = (args) => exec("gh", args);

export async function ghAvailable(): Promise<boolean> {
  try {
    await runGh(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The verifier, over a `gh` runner. Before it verifies, it asks GitHub which commit the tag
 * `v<version>` names now and pins the attestation to it (`--source-digest`): the attestation's
 * `--source-ref` is the tag's name only, so a tag built from a commit off main and then moved onto
 * one on main would pass a check of the name alone (review of #547, the re-review's S2).
 */
export function makeGhVerifier(run: GhRun): ExtraVerifier {
  return async ({ bytes, repository, product, version }) => {
    let commit: string;
    try {
      commit = (
        await run(["api", `repos/${repository}/commits/refs/tags/v${version}`, "--jq", ".sha"])
      ).stdout.trim();
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new VerificationError(`could not read the commit tag v${version} names: ${detail}`);
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new VerificationError(`tag v${version} names no commit GitHub could give (${commit})`);
    }
    const dir = await mkdtemp(join(tmpdir(), "demo-verify-"));
    const file = join(dir, releaseAssetNames(product, version).bundle);
    try {
      await writeFile(file, bytes);
      await run([
        "attestation",
        "verify",
        file,
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/.github/workflows/release.yml`,
        "--source-ref",
        `refs/tags/v${version}`,
        "--source-digest",
        commit,
        "--deny-self-hosted-runners",
      ]);
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new VerificationError(`gh attestation verify failed: ${detail}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export const ghVerifier: ExtraVerifier = makeGhVerifier(runGh);
