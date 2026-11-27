// The shipped packs' extension files, as a release carries them (not their config or tests): each
// top-level file of a pack by its name.
// One glob for every test file, so a test names the packs it installs rather than globbing each.
import type { ExtensionHost } from "@composable-os/core";
import { host } from "./helpers.ts";

const sources = import.meta.glob<string>("../../../packs/*/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A glob's files keyed by file name, without the vitest config a pack folder also holds. */
export const filesByName = (glob: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );

/** The top-level files of the shipped pack `id` (`packs/<id>/*.ts`). */
export function packFiles(id: string): Record<string, string> {
  const files = filesByName(
    Object.fromEntries(
      Object.entries(sources).filter(([path]) => path.startsWith(`../../../packs/${id}/`)),
    ),
  );
  if (Object.keys(files).length === 0) throw new Error(`No pack ${id}`);
  return files;
}

const GYM: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  bookings: packFiles("bookings"),
  memberships: packFiles("memberships"),
};

/** The extension host of a deployment whose product lists Bookings, Memberships and Programs. */
export const gymHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !(s.id in GYM)),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    GYM[id]
      ? host.commit({
          id,
          files: GYM[id],
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};
