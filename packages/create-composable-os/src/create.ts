// Entry point for `npm create composable-os <dir>` (the create-composable-os bin): a thin alias for
// `cos create` (stage 24). Installing a product with no client repo is `cos install`.
import { ghAvailable, ghVerifier } from "./gh.ts";
import { Redactor, terminalIo } from "./io.ts";
import { runCli } from "./main.ts";

const redactor = new Redactor();
const code = await runCli(["create", ...process.argv.slice(2)], {
  io: terminalIo(redactor),
  redactor,
  env: process.env,
  ghVerifier: (await ghAvailable()) ? ghVerifier : null,
});
process.exitCode = code;
