// The native base layer's look, in one place: change these to the company's brand.
export const theme = {
  color: {
    background: "#ffffff",
    surface: "#f4f4f5",
    text: "#18181b",
    muted: "#71717a",
    primary: "#18181b",
    onPrimary: "#fafafa",
    border: "#e4e4e7",
    danger: "#dc2626",
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24 },
  radius: 8,
  font: { body: 16, small: 13, title: 24 },
} as const;
