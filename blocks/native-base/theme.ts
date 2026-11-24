// The native base layer's look, in one place: change these to the company's brand. Every text,
// icon and surface a native block draws takes its colour from here (the block lint refuses a
// colour of a block's own), so a dark theme is these values changed.
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
    /** What went well, and the quiet surfaces behind a yes and a no (the door scanner's). */
    success: "#10b981",
    successSurface: "#dcfce7",
    dangerSurface: "#fee2e2",
    info: "#0ea5e9",
    warning: "#f59e0b",
    /** Behind the screen while a sheet is open. */
    scrim: "rgba(0,0,0,0.3)",
    /** Behind a code to be scanned: a scanner reads dark on light, whatever the theme. */
    codeBackground: "#ffffff",
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24 },
  radius: 8,
  font: { body: 16, small: 13, title: 24 },
} as const;
