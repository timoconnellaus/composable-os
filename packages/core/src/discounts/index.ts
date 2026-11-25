// The discount behaviour (stage 34 step 4, ADR 0693). Importing this registers the order's move
// hook for discount uses (held, used, released).
import "./uses.ts";

export * from "./deal.ts";
export * from "./uses.ts";
