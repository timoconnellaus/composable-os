// The browser's time zones, for the pickers and for "today" where the person is.

/** The browser's own IANA time zone, else UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA time zone the browser knows, or `fallback` in a browser that cannot list them. */
export function supportedTimeZones(fallback: string[] = []): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return fallback;
  }
}
