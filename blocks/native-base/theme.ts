// The native base layer's look, in one place. The brand colours come from `../brand.ts`, which cos
// writes from product.ts (`mobile.app.colours`); the rest is the base layer's and may be edited.
import { brand } from "../brand.ts";

export const theme = {
  color: {
    background: brand.background,
    surface: "#f4f4f5",
    text: brand.text,
    muted: "#71717a",
    primary: brand.primary,
    onPrimary: brand.onPrimary,
    border: "#e4e4e7",
    danger: "#dc2626",
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24 },
  radius: 8,
  font: { body: 16, small: 13, title: 24 },
} as const;
