// The docs site's settings, read by scripts/generate.mjs. Everything else comes from the code and
// the Markdown beside it.
export default {
  /** Where the site is served (the owner's decision of 2026-11-24, ADR 0930). */
  site: "https://docs.composableos.dev",
  /** Links to files that are not pages go to the repository, on main. */
  repository: "https://github.com/timoconnellaus/composable-os",
  /**
   * Packs whose docs/overview.md is not written yet, with their stage. The check fails when a pack
   * has no overview and is not listed here, and when a listed pack has one (take it off the list).
   */
  overviewsPending: {
    content: { stage: 28 },
    courses: { stage: 42 },
    dailychecks: { stage: 45 },
    deals: { stage: 4 },
    leads: { stage: 15 },
    lifecycle: { stage: 15 },
    memberships: { stage: 32 },
    programs: { stage: 41 },
    ticketing: { stage: 27 },
  },
  /**
   * Names that never appear on the site: a client's. Matched in any case, inside identifiers too
   * (`name-app`). On the glossary and Planned, whose sources name a client by the repository's own
   * choice, the page says "the first client" (or "client" in an identifier); anywhere else a name
   * fails the run, and its source is reworded.
   */
  privateNames: ["Ghetto Movement", "Ghetto"],
};
