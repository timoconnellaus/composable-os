# Website redo

## Decided
- **Design language:** the reference you sent. Light blue page, bold Poppins headings, lime pill button, dark pill in the header, blue arches behind a product picture, navy and lime as accents.
- **Skill:** `landing-page-generator` (borghei/Claude-Skills) gets copied into `skills/landing-page-generator` and linked into `.claude/skills`, like the other skills. Its licence is MIT plus the Commons Clause (no selling the skill itself), so the copy carries the licence notice and a line in `UPSTREAMS.md`.
- **Instructions:** `CLAUDE.md` only imports `AGENTS.md`, so the two new rules go in `AGENTS.md`: use the skill for any work on the site, and update the site when a feature ships.

- **The angle:** you can compose a custom product that fits the business. Building the right product for any business is the reason Composable OS exists. "Your AI builds, you approve" is how it stays safe, and moves down the page as support.

- **What it sells:** a service. We build your company's own software on Composable OS. The toolkit is the second part, for developers and agencies.
- **Reader:** the owner or operations lead at a small or mid-size company. So the copy is non-technical until the developer section.
- **Headline:** "A head start on custom software to fit your business" (your wording).
- **One action:** Book a call, worded the same in the header, hero, mid-page and close. It leads to a short form on the page (name, email, company, what you need), stored by the site's own Worker.
- **The pain:** loads of SaaS subscriptions, nothing quite right, concessions to make it work, nickel-and-dimed everywhere. This is the problem section, and it makes the copy problem-first (PAS in the skill's terms).
- **Where visitors come from:** links you send directly, GitHub and developer communities, LinkedIn and other social posts. No ads and no search campaign, so it stays a site page with a short header menu. Developers arriving from GitHub get "For developers" in the menu, which takes them straight to their section.
- **Who "we" is:** Zero BS AI. Named in the hero's supporting line, the questions, the close and the footer.
- **Look:** light only, Poppins headings, lime main button. Dark mode goes.
- **Proof:** Ghetto. The quote and a case study come later, so the prototype has a dashed placeholder for them after "What we build". Nothing invented goes live.

- **Business model:** Zero BS AI builds the product, then maintains it on a subscription. The customer can have the code if they want it, but the point is that it is looked after for them. The page sets this against the pain as one subscription for software that fits, in place of a dozen that don't.
- **The subscription covers:** hosting and keeping it running, updates to the platform underneath, fixes, changes and new features as the business changes, and support for the team. It gets its own section, "One subscription, and nothing extra to buy".
- **Where it runs:** settled per customer, and the page doesn't say. Cloudflare is named only in the developer section.
- **Price:** the page says nothing about what the service costs; it comes up on the call. The questions section says so, and that running costs go to Cloudflare directly.
- **The hosted CRM offer goes:** no waitlist, no plans. The CRM is one piece that can be in a solution, shown as "Customers and sales" beside ticketing, content and "the part only you have".
- **The toolkit:** one section near the end, linking to GitHub.
- **Hero picture:** an invented business (a coffee roaster's orders board).
- **Ghetto:** nothing goes live until the quote arrives; the case study section is added then, after "What can go in".

## The page
1. Hero: headline, Book a call, the invented business's product
2. Facts bar (no invented proof)
3. The problem: a dozen subscriptions, nothing fits, you make the concessions, nickel-and-dimed
4. How it works: tell us how you work, we compose it, we look after it
5. What can go in: customers and sales (ready), ticketing and content (in design), the part only you have
6. What's inside: records, rules, screens, automations, connections, dashboards
7. Looked after: what the one subscription covers
8. When the business changes: AI does the work, your people stay in charge
9. For developers and agencies: build on it yourself
10. Questions
11. Close: the Book a call form (name, email, company, what you need)

## What the build changes
- `apps/marketing`: new tokens and styles (light only, Poppins self-hosted), sections rewritten as above, the old Pricing, Enterprise, waitlist and hero demo components removed.
- The Worker's form: the call form posts as a contact request with name, company and message (a new migration adds the columns). Existing waitlist rows stay in the database.
- Tests, screenshots, the social image, the README and ADR 0191 (a dated note) updated to match.
- `skills/landing-page-generator` added with its licence notice, linked into `.claude/skills`, listed in `skills/README.md` and `UPSTREAMS.md`.
- `apps/marketing/SITE.md`: a short file saying what the site says, section by section (the angle, the reader, the one action, each section's claims, and what is marked "in design"). An agent reads this to see whether a change touches the site, without reading the page's source.
- `AGENTS.md`: use that skill for any work on the site. When a change adds or alters something the site describes, update the site and `SITE.md` in the same PR.
- The skill's three checks (calls to action, conversion checklist, page weight) run on the built page.

## Open
- Your go-ahead on the prototype as it stands.
