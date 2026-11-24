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
   * Names that never appear on the site: a client's. Where a source names one (the glossary, the
   * roadmap), the page says "the first client"; anything else that would show one fails the run.
   */
  privateNames: ["Ghetto Movement", "Ghetto"],
};
