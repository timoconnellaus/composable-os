// Routine messages (ADR 0670): a push opens a screen of the business's app, never a web address.
// Every shipped pack's kind that goes by push names a screen one of that pack's native blocks
// declares (block.json `screens`). `cos ext check` cannot see this (the manifest does not carry
// the blocks), so the repository checks it here, for every pack.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPackIds } from "../src/packs.ts";

const root = join(import.meta.dirname, "..", "..", "..");

interface Kind {
  channels?: readonly string[];
  open?: { screen: string };
}

/** The screens a pack's native blocks declare. */
function nativeScreens(pack: string): Set<string> {
  const dir = join(root, "packs", pack, "blocks");
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "block.json");
    if (!existsSync(file)) continue;
    const block = JSON.parse(readFileSync(file, "utf8")) as { skin?: string; screens?: string[] };
    if (block.skin === "native") for (const screen of block.screens ?? []) out.add(screen);
  }
  return out;
}

describe("the screens a push opens", () => {
  it("are screens the pack's own native blocks declare", async () => {
    let pushing = 0;
    for (const pack of repositoryPackIds(root)) {
      const index = join(root, "packs", pack, "index.ts");
      if (!existsSync(index)) continue;
      const mod = (await import(pathToFileURL(index).href)) as {
        default?: { routineMail?: Record<string, Kind> };
      };
      const screens = nativeScreens(pack);
      for (const [kind, spec] of Object.entries(mod.default?.routineMail ?? {})) {
        if (!(spec.channels ?? []).includes("push")) continue;
        pushing += 1;
        expect(
          screens.has(spec.open?.screen ?? ""),
          `${pack}.${kind} opens ${spec.open?.screen}`,
        ).toBe(true);
      }
    }
    // Bookings' and Ticketing's kinds go by push: the check has something to check.
    expect(pushing).toBeGreaterThanOrEqual(6);
  });
});
