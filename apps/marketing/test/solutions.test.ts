// The solutions' pages, as data: each has a route-safe slug, a title and description of the length
// the landing-page skill asks for, and pieces whose status is one of the site's words, in the group
// that matches it. The gym page says plainly that what would replace a booking system is not built,
// and names its first gym only as being moved, never as live.
import { describe, expect, it } from "vitest";
import { SOLUTIONS } from "../src/solutions.ts";
import { STATUS, type Status } from "../src/status.ts";

const BUILT: Status[] = ["ready", "built"];
const NOT_YET: Status[] = ["building", "design", "planned"];

describe("solutions", () => {
  it("each status word is distinct", () => {
    const words = Object.values(STATUS);
    expect(new Set(words).size).toBe(words.length);
  });

  it("slugs are unique and safe in a path", () => {
    const slugs = SOLUTIONS.map((solution) => solution.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  for (const solution of SOLUTIONS) {
    describe(solution.label, () => {
      it("has a title of 50 to 60 characters and a description of 150 to 160", () => {
        expect(solution.title.length).toBeGreaterThanOrEqual(50);
        expect(solution.title.length).toBeLessThanOrEqual(60);
        expect(solution.description.length).toBeGreaterThanOrEqual(150);
        expect(solution.description.length).toBeLessThanOrEqual(160);
      });

      it("groups its pieces by status: built ones first, then the rest", () => {
        for (const piece of solution.pieces.built) expect(BUILT).toContain(piece.status);
        for (const piece of solution.pieces.notYet) expect(NOT_YET).toContain(piece.status);
      });

      it("uses no em dash and names no price", () => {
        const text = JSON.stringify(solution);
        expect(text).not.toContain("—");
        expect(text).not.toMatch(/\$\d|per month/i);
      });

      it("names its first business only as being moved, not as live", () => {
        if (!solution.first) return;
        expect(solution.first.heading).toContain(solution.first.name);
        expect(solution.first.heading).toMatch(/being moved/);
        expect(solution.first.body).toMatch(/not live yet/);
      });
    });
  }

  it("the gym page marks what would replace a booking system as not built", () => {
    const gyms = SOLUTIONS.find((solution) => solution.slug === "gyms");
    const status = (title: string) =>
      [...(gyms?.pieces.built ?? []), ...(gyms?.pieces.notYet ?? [])].find(
        (piece) => piece.title === title,
      )?.status;
    expect(status("Class bookings")).toBe("design");
    // Stage 32b step 6: plans, memberships and passes are merged; the rest is in progress.
    expect(status("Memberships and passes")).toBe("building");
    expect(status("Moving from your booking system")).toBe("planned");
    // Stage 32a: the subscription (step 3) and moving the current subscribers (step 4) are built.
    expect(status("Course subscriptions")).toBe("built");
    expect(status("Moving your course subscribers")).toBe("built");
  });
});
