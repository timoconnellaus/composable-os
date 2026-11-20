// Node-only: what is built from @composable-os/sdk's source for running and type-checking
// extension source. cos-runner's build (apps/runner/scripts/bundle.mjs) writes both into its
// bundle; `cos ext check` builds them when it runs. One definition, so the two cannot drift.
//
// This file is imported by a plain `node` script, so it uses only syntax Node can strip
// (no enums, no parameter properties) and takes the compiler as an argument.
import { realpathSync } from "node:fs";
import { basename, relative } from "node:path";
import type { SdkTypes, TypeScript } from "./typecheck.ts";

/**
 * esbuild options for the SDK as one ES module (specifier `cos-sdk` beside built extension
 * modules), with zod inlined.
 */
export function sdkBundleOptions(sdkEntry: string): {
  entryPoints: string[];
  bundle: true;
  format: "esm";
  platform: "neutral";
  target: string;
  minify: true;
  write: false;
  legalComments: "none";
  mainFields: string[];
  conditions: string[];
} {
  return {
    entryPoints: [sdkEntry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
  };
}

/**
 * The declarations the extension type checker needs (typecheck.ts): @composable-os/sdk's .d.ts
 * (emitted from `sdkSrcDir`), the zod .d.ts files they reach, and the ES2022 lib files (no DOM),
 * comments stripped, at virtual paths, plus every import's resolution between them, so the checker
 * needs no module resolution of its own for these files.
 */
export function buildSdkTypes(ts: TypeScript, sdkSrcDir: string): SdkTypes {
  const sdkSrc = realpathSync(sdkSrcDir);
  const program = ts.createProgram([`${sdkSrc}/index.ts`], {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => sdkSrc,
        getNewLine: () => "\n",
      }),
    );
  }
  const emitted: Record<string, string> = {};
  program.emit(undefined, (fileName, text) => {
    emitted[fileName] = text;
  });
  const printer = ts.createPrinter({ removeComments: true });
  const toVirtual = (real: string) => {
    if (real.startsWith(`${sdkSrc}/`) && real.endsWith(".ts") && !real.endsWith(".d.ts")) {
      return `/sdk/${relative(sdkSrc, real).replace(/\.ts$/, ".d.ts")}`;
    }
    const zod = real.indexOf("/node_modules/zod/");
    if (zod !== -1) return real.slice(zod);
    throw new Error(`typecheck declarations: unexpected file ${real}`);
  };
  const files: Record<string, string> = {};
  const sources: [virtual: string, real: string, text: string][] = [];
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf)) {
      files[`/lib/${basename(sf.fileName)}`] = printer.printFile(sf);
      continue;
    }
    const virtual = toVirtual(sf.fileName);
    const text = virtual.startsWith("/sdk/")
      ? emitted[sf.fileName.replace(/\.ts$/, ".d.ts")]
      : printer.printFile(sf);
    if (text === undefined) throw new Error(`typecheck declarations: no .d.ts for ${sf.fileName}`);
    files[virtual] = text;
    sources.push([virtual, sf.fileName, text]);
  }
  const resolutions: Record<string, Record<string, string>> = {};
  for (const [virtual, real, text] of sources) {
    const info = ts.preProcessFile(text, true, true);
    if (info.referencedFiles.length || info.typeReferenceDirectives.length) {
      throw new Error(`typecheck declarations: ${virtual} has reference directives`);
    }
    const map: Record<string, string> = {};
    for (const { fileName: specifier } of info.importedFiles) {
      const resolved = ts.resolveModuleName(specifier, real, program.getCompilerOptions(), ts.sys)
        .resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error(`typecheck declarations: ${specifier} from ${real}`);
      const target = toVirtual(realpathSync(resolved));
      if (!Object.hasOwn(files, target)) throw new Error(`typecheck declarations: ${target}`);
      map[specifier] = target;
    }
    if (Object.keys(map).length) resolutions[virtual] = map;
  }
  return { entry: "/sdk/index.d.ts", files, resolutions };
}
