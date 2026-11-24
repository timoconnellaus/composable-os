// How an extension's relative imports resolve to its own files: one rule for the build
// (build.ts) and the type check (typecheck.ts). No dependencies, so the type check's Worker does
// not take the transpiler with it.

/** Joins a path's parts, `.` and `..` applied; null when `..` leaves the extension. */
function normalise(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * The file `specifier` names from the extension file `from`: `./x`, `./x.ts`, `./x.js` (also when
 * only `x.ts` exists) or `./x/index.ts`. Null when it names no source file `has` knows.
 */
export function resolveOwnImport(
  from: string,
  specifier: string,
  has: (path: string) => boolean,
): string | null {
  const i = from.lastIndexOf("/");
  const base = normalise(`${i === -1 ? "" : from.slice(0, i)}/${specifier}`);
  if (base === null) return null;
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${base}.ts`, `${stem}.ts`, `${base}.js`, `${base}/index.ts`]) {
    if (/\.(ts|js)$/.test(candidate) && has(candidate)) return candidate;
  }
  return null;
}
