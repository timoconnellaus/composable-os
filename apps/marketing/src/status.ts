// The words the site uses for how far along a piece is, and nothing stronger than the repository
// shows. SITE.md ("What the status words mean") defines each one; keep the two together.
export const STATUS = {
  /** Built, merged and tested, and part of the CRM or used by a customer in production. */
  ready: "Ready today",
  /** Built, merged and tested; no customer yet; outside services run only against a test double. */
  built: "Built, not yet live",
  /** Part of it is merged, the rest is in progress. */
  building: "Being built",
  /** Agreed in a spec; nothing built yet. */
  design: "In design",
  /** On the roadmap with no spec yet. */
  planned: "Planned",
} as const;

export type Status = keyof typeof STATUS;
