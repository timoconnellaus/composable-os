// The app's brand colours, which the native base theme reads (native-base/theme.ts). In a client
// app this file is `src/blocks/brand.ts`, written by cos from product.ts's `mobile.app.colours`
// (stage 63, ADR 0900): change product.ts, not the file. This one is the platform's default look.
export const brand = {
  primary: "#18181b",
  onPrimary: "#fafafa",
  background: "#ffffff",
  text: "#18181b",
} as const;
