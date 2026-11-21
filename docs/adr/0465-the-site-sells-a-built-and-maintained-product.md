# ADR 0465: The site sells a product built for the business and looked after

Status: accepted, 2026-11-21 (website interview). Amends the landing page part of
[ADR 0191](0191-saas-and-enterprise-model.md).

## Context
The first site (stage 9) led with "your AI builds, you approve" and sold two things at once: the
platform, and a hosted CRM with a waitlist and plans at $0, $39 and $149 a month. The owner's
reason for Composable OS is different: a business can have a product composed to fit it, where
today it rents a dozen subscriptions, none of which is quite right. The CRM is one piece that can
be in such a product, not the offer.

## Decision
- **The offer is a service.** Zero BS AI builds a company's own software on Composable OS, then
  maintains it on one subscription. The customer can have the code, but the point is that it is
  looked after for them. The toolkit, for developers and agencies, is the second part of the offer
  and gets one section.
- **The subscription covers** hosting and keeping it running, updates to the platform underneath,
  fixes, changes and new features as the business changes, and support for the team using it. The
  site lists exactly these.
- **The reader** is the owner or operations lead at a small or mid-size company. The copy is
  non-technical until the developer section. Their pain, in their words: loads of subscriptions,
  nothing quite right, concessions to make it work, nickel-and-dimed everywhere.
- **One action:** "Book a call", worded the same in the header, the hero, mid-page and the close.
  It leads to a short form (name, email, company, what you need) stored by the site's own Worker
  as a `sales` request. No scheduling service, so the no-trackers rule holds.
- **No price on the page.** It comes up on the call. The page says nothing about where a
  customer's product runs either: that is settled per customer.
- **The hosted CRM offer is off the site:** no waitlist and no plans. The endpoint still accepts
  a `waitlist` submission and the rows already stored stay.
- **Proof is real or absent.** Ghetto is the first client; its quote and case study are added
  when they exist. Until then the page shows plain facts and nothing invented.
- **Design language:** light only; Poppins; a pale blue page on a near-white frame; one lime pill
  button for the action and a dark pill in the header; blue arches behind the product picture;
  navy and lime as accents. The hero's picture is an invented business's product (a coffee
  roaster's orders board), so it reads as "this could be yours".
- **Kept current.** `apps/marketing/SITE.md` says what the site claims, section by section. A
  change that adds or alters something the site describes updates the site and `SITE.md` in the
  same pull request (`AGENTS.md`). Site work follows the `landing-page-generator` skill
  (`.claude/skills/landing-page-generator`), and its three checks run on the built page.

## Consequences
- The site no longer shows the plans ADR 0191 describes. Whether the hosted SaaS in ADR 0191 is
  still built is not decided here; this ADR changes only what the site offers.
- A feature that changes what a product can be made of (a new pack, a new connection, a piece
  moving from "in design" to built) now has a second place to update.
