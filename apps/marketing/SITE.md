# What the site says

A short account of composableos.dev, so nobody has to read the page's source to know whether a
change touches it. **When a change adds or alters anything below, update the page and this file in
the same PR** (`AGENTS.md`, "The site"). The decisions behind it are in
[ADR 0465](../../docs/adr/0465-the-site-sells-a-built-and-maintained-product.md).

- **The offer:** Zero BS AI builds a company's own software on Composable OS, then looks after it
  on one subscription. The toolkit itself is the second part, for developers and agencies.
- **The reader:** an owner or operations lead at a small or mid-size company. A solution's page
  is for one kind of business (the first: gyms and studios), often arriving from search.
- **The pages:** the home page (`/`), one page per solution (`/solutions/<slug>/`, from
  `src/solutions.ts`; only `/solutions/gyms/` exists), and the short pages (privacy, the form's
  results, not found). Solutions are listed on the home page and in `public/sitemap.xml`; the
  header's "Solutions" link goes to the home page's section.
- **The one action:** "Book a call" (`CTA` in `src/links.ts`), leading to the form at `#call`.
  Every page that sells has its own form there, so the action never leaves the page.
- **Not on the site:** prices, where a customer's product runs, a hosted CRM, a waitlist, dark
  mode, and any proof that isn't real. (A class's queue for a place is written "waiting list", so
  the word "waitlist" stays off the page: the landing e2e test refuses it.)

## The home page, section by section

| # | Section (component) | What it claims |
| --- | --- | --- |
| 1 | Hero (`Hero`) | Headline: "A head start on custom software to fit your business". The parts every business product needs are already built (records, rules, screens, approvals, connections); Zero BS AI composes them into the product and then looks after it. The call is 30 minutes. The picture is an invented coffee roaster's orders board with a change waiting for approval. |
| 2 | Facts bar (`Hero`) | Built for your business. Looked after by us, on one subscription. The code is yours if you want it. Your data stays yours. |
| 3 | The problem (`Problem`) | A dozen subscriptions and none is quite right: nothing quite fits, you make the concessions, nickel-and-dimed everywhere. |
| 4 | How it works (`HowItWorks`) | Three steps: tell us how you work; we compose your product; we look after it (hosting, fixes, support and changes). |
| 5 | What can go in (`Pieces`) | **Customers and sales** (people, organisations, deals, leads, pipelines, email on the timeline): ready today. **Ticketing** (events, ticket types, checkout in full or by deposit, tickets in the app, door scanning): built, not yet live (stage 27 steps 1 to 5). **Content** (blog posts, drafts, preview links, scheduled publishing, pictures, an import of old posts): built, not yet live (stage 28). **Programs** (training programs from an exercise bank, given to a person or a class, every set logged on the web and in the app): built, not yet live (stage 41). **Courses** (video lessons sold one at a time, in bundles or by a monthly subscription with a free trial, progress, only those who hold them can play them; members cancel and update their card on the web; subscribers moving from another platform continue free until their paid-up date): built, not yet live (stage 42; the subscription and the move are stage 32a steps 1 to 4). **Memberships** (monthly memberships, unlimited or N classes a week or month, passes bought once: class packs that expire, drop-ins, an intro offer one per person; members see what they have left, used up as they book classes, and change plan on the web; staff pause a membership for a set time): being built (stage 32b, steps 6 and 7 merged; the import still to come). **Bookings** (classes made from a weekly timetable, booked and cancelled on the web and in the app within each class type's rules: when booking opens and closes, when a cancel is late; a full class's waiting list moves people in on their own; parents book for their children; a visitor pays for a single class on the website, no account needed, the place held while they pay; staff book anyone, walk-ins too, move a member to another class and cancel a class before it ends, giving back the class of everyone on it who booked with a membership or pass, even those already ticked or who cancelled late, and refunding to the card anyone who paid for that class on the website once a member of staff approves it (a booking paid at the desk has nothing to give back); members emailed when they book, when the gym changes or cancels their class, and with a reminder before it, with a file that adds the class to their calendar, by default staff approving each one until the business turns automatic emails on; coaches tick who came in the app; on the web staff work the front desk and the class list in the product's admin, and a coach signs in there to just the class list; the web screens are not yet tried on a live host): being built (stage 31a steps 1 to 9 merged; the import and one-to-one sessions still to come). **Rostering** (Who works each class and each shift that is not a class, like cleaning. A weekly pattern makes the shifts eight weeks ahead, nobody is ever put on two at once, and staff say when they are away and offer a shift they cannot work for a qualified colleague to take, with the manager told. A duty can carry a checklist the person on the shift ticks off, and the manager is told when one is missed. Hours and classes are totalled per pay period for the staff paid by them and locked, with a file for payroll, and each of them can see their own; no pay rates are kept. Each person's own shifts are published at a private calendar address only they get, from their own calendar screen. Staff use the screens on the web in the product's admin, each person seeing only the ones they may use, and in the app (not yet tried on phones); the web screens are not yet tried on a live host, and the calendar address is not yet tried in phone calendars): being built (stage 45 steps 1 to 7 and 4b merged: the host's rules for shifts, the Rostering pack's duties, weekly patterns and tools, each person's private calendar feed, pay periods, the screens, and checklists on a duty; a business's own set-up still to come). **Agreements** (terms, waivers, health questions and a parent's consent, written by the business and agreed to on the web or in the app with a typed name or a drawn signature; visitors agree on the way to paying, parents for their children; nobody books a class or buys a membership or pass without agreeing first (not yet said of tickets and courses, whose checkouts have no agreement step); a copy by email to whoever agrees online, and the signed PDF the business can download at any time; the app's screens built but not yet tried on phones; still to come: signing on the business's own tablet at the desk, and a cooling-off period): being built (stage 44 steps 1 to 5 merged). **The part only you have:** built for that business. |
| 5a | Solutions (`Solutions`) | A solution is the whole system for one kind of business, with every piece marked built or still to come. One card per solution in `src/solutions.ts`, each linking to its page: today only "For gyms and studios". No placeholder for a solution that does not exist. |
| 6 | What's inside (`Inside`) | Every product starts with: your records; your rules (stages, prices, who may see and do what, for people and AI); your screens (a web app, a mobile app when needed, for staff and customers); automations (tested before they go live); connections (email, calendars, Slack, payments); dashboards (describe a chart and get one). |
| 7 | Looked after (`Care`) | The subscription covers: hosting and keeping it running; updates to the platform; fixes; changes and new features as the business changes; support for the team. No seats, tiers or add-ons. |
| 8 | When the business changes (`Control`) | The product is changed by asking, in the app or from Claude, ChatGPT or Cursor. Admins decide what needs a person. Approved (new fields, bulk edits, deletes and outgoing emails wait for sign-off), sandboxed (no internet except through approved connections), audited (every action logged with who and why). |
| 9 | For developers and agencies (`Developers`) | The same toolkit is available: source available and free to self-host; skills that teach a coding agent to write extensions; Workers, D1 and R2 on Cloudflare. Commands: `npm create composable-os`, `pnpm cos add web-sign-in`, `pnpm cos deploy`, `pnpm cos content import` (and, named in a comment, `cos courses import`, `cos subscriptions offers import` and `cos rostering import`). |
| 10 | Questions (`src/faq.ts`) | The data is the customer's and they can have the code; the platform's source is public. Cost: one subscription once built, figure after the call. Leaving: they take the code and data. The AI changes only what admins allow. Connections today: email, calendars, Slack, payments, webhooks. |
| 11 | The close (`FinalCta`, `CallForm`) | The form: name, email (required), company, what you need. A reply within one working day. No newsletter, no trackers. |
| | Footer | Composable OS is built and run by Zero BS AI. |

## The gym page (`/solutions/gyms/`), section by section

Rendered by `src/pages/solutions/[slug].astro` from the `gyms` entry in `src/solutions.ts`.
Title "Gym and studio software, looked after · Composable OS"; the description names events,
online courses, training programs and the blog on the gym's own site and app.

| # | Section | What it claims |
| --- | --- | --- |
| G1 | Hero | Eyebrow "For gyms and studios". Headline: "Gym and studio software, built around how you run yours". Events, online courses, training programs and the blog in one system, on the gym's own site and app, with class bookings and memberships still to come; Zero BS AI composes it and looks after it on one subscription. The call is 30 minutes. No picture. |
| G2 | Facts bar | Every member is one record, not five. Your own site and app. Looked after by us, on one subscription. Your data stays yours. |
| G3 | The problem | A booking system, a course platform, ticketing, a website and a programming app that don't talk to each other: a bill for every job, the same member five times, gaps filled by hand. |
| G4 | What's in it (`#pieces`) | **Built:** Members and enquiries (one person per member, buyer, student and enquiry, with history and emails): ready today (the base records and the Leads pack; buyers and students are People, stages 27 and 42). Events and camps (ticket types with their own places, in full or by deposit, tickets in the app, door scanning): built, not yet live (stage 27). Online courses (bundles, web and app, progress, only payers can play, an import of courses and students): built, not yet live (stage 42). Course subscriptions (one monthly subscription to every course including later ones, a free trial per person, the gym's own Stripe account, cancelling and the card on the website): built, not yet live (stage 32a steps 1 to 3). Moving the course subscribers (they sign in and continue, free until their paid-up date, then charged; a list shows who has moved, so the gym ends exactly those old subscriptions): built, not yet live (stage 32a step 4). Training programs (exercise bank, a member or a whole class, every set logged against its target): built, not yet live (stage 41). The blog (drafts, preview links, scheduled publishing, an import of old posts): built, not yet live (stage 28). The part only the gym has. **Still to come**, with the line that these are what would replace a booking system and that it stays until they are built: Class bookings (classes made from the weekly timetable, booked and cancelled on the site and app within each class type's rules: when booking opens and closes, when a cancel is late, classes only staff book; a full class has a waiting list: a place freed in time goes to the first person waiting who has a membership or pass to pay with, moved in on their own and paid from it then; parents the gym has linked to their children book, cancel and join the waiting list for them, paid from the child's own membership or pass; a visitor, or a member with nothing to book with, pays for a single class on the website, no account needed, the place held while they pay and booked once the payment goes through, the money back to the card once a member of staff approves it when they cancel in time, kept when they cancel late; staff book anyone, walk-ins too, move a member to another class with the class it used, and cancel a class before it ends, giving everyone who booked it with a membership or pass that class back, including anyone already ticked or who cancelled late, and refunding anyone who paid for it on the website to their card once a member of staff approves it (a booking paid at the desk has nothing to give back); members, and parents about their children, emailed when they book, with a file that adds the class to their calendar, when the gym changes the time or room or cancels their class, and with a reminder a few hours before it (3 by default, set per class type), by default staff approving each one until the gym turns automatic emails on, each of these emails one an admin can turn off; coaches tick who came on the class list in the gym's app, and a no-show keeps the class used; on the web staff work the front desk and the class list in the product's admin, and a coach signs in there to just the class list; the web screens are not yet tried on a live host; still to come: one-to-one sessions booked by staff): being built (stage 31a: steps 1 to 9, the behaviours, the Bookings pack's spine, spending a membership's use, the waitlist, the family link, attendance, moves and cancelling a class, drop-ins paid on the website, and the emails, the reminder and the coach's list in the app, merged; the import still to come). Memberships and passes (monthly memberships, unlimited or N classes a week or month; passes bought once: class packs that expire, drop-ins, an intro offer one per person; members see what they have left, used up as they book classes, and change plan on the website, a dearer plan at once and a cheaper one from the next billing period; staff pause a membership for a set time, nothing charged meanwhile): being built (stage 32b: plans, memberships and passes merged in step 6; plan changes, pauses and the dashboard in steps 6 and 7; the import still to come). Rostering (Which coach takes each class, and who does each shift that is not a class, like the clean after the last class. A weekly pattern makes the shifts eight weeks ahead and you change single dates; nobody is ever on two shifts at once. Staff say when they are away and offer a shift they cannot work: a colleague who may coach that class type takes it with nobody approving, and you are told. A duty like the closing clean can carry a checklist the person on the shift ticks off, and you are told when one is missed. Members still see only the coach's public profile: name, photo and bio. For staff paid by the hour or by the class, each pay period's hours and classes are totalled from the roster and locked, with a file for payroll, and each of them can see their own; no pay rates are kept. Staff see their own shifts, take offered ones, say when they are away and get a private calendar address for their phone's calendar; you see the roster week, put people on shifts, set the regular week, who may coach what, everyone's time off and pay. Staff use the screens on the web in the product's admin, each person seeing only the ones they may use, and in the app (not yet tried on phones); the web screens are not yet tried on a live host, and the calendar address is not yet tried in phone calendars): being built (stage 45 steps 1 to 7 and 4b merged). Waivers and agreements (the gym's membership terms, waiver, health questions and a parent's consent, in its own words; members read and agree on the site or in the app, by ticking and typing their name or drawing a signature, as the gym chooses per document; a visitor agrees on the way to paying for a class, a parent for their child; nobody books a class or buys a membership or pass without agreeing first, and a changed document can ask everyone again before their next booking; a copy by email to whoever agrees online, and the signed PDF the gym can download at any time; the app's screens built but not yet tried on phones; health answers read only by the staff the gym allows, a coach sees a mark beside the name; still to come: signing on the gym's own tablet at the desk, and a cooling-off period): being built (stage 44 steps 1 to 5 merged). Moving from a booking system (clients, visit history, passes, schedules, both running side by side for a time): planned (stage 33, no spec). |
| G5 | The first gym | Ghetto Movement is being moved onto it; it is not live yet. The name only (the owner's decision, 2026-11-22): no quote, logo, price, numbers, the systems it is leaving, or case study. |
| G6 | Looked after (`Care`) | As home row 7. |
| G7 | Questions (`questions` in `src/solutions.ts`) | The booking system stays while class bookings and memberships are being built, and the move from it comes after both are. Tickets, courses and programs have screens for the gym's own app and its website. Payments go to the gym's own Stripe account; nothing on the platform charges a card on its own (stage 25, ADR 0485). Cost as home row 10. |
| G8 | The close (`FinalCta`, `CallForm`) | "Tell us how your gym runs." The same form, reply time and promises as home row 11. |

## What the status words mean

Each piece on the home page (row 5) and on a solution's page gets one of these (`src/status.ts`),
and nothing stronger than the repository shows:

- **Ready today:** built, merged and tested, and either part of the platform's own product (the
  CRM) or used by a customer in production; it goes into a product as it is.
- **Built, not yet live:** built, merged and tested end to end, and it can go into a product, but
  no customer has used it yet, and anything it needs from an outside service (Stripe for payments
  and tax, Cloudflare Stream for video) has run only against the test double.
- **Being built:** part of it is merged and the rest is in progress (Class bookings, stage 31a;
  Memberships and passes, stage 32b; Rostering, stage 45; Agreements, stage 44). The card may say what it still waits for.
- **In design:** agreed in a spec; nothing built yet. It may wait for another stage, and the card
  says so.
- **Planned:** on the roadmap, with no spec yet, or a spec proposed and not yet agreed (moving
  from a booking system, stage 33). Used on a solution's page, where the reader needs to see what
  is missing; the home page lists only pieces that are built or being built.

## What changes it

- A pack or piece is added, or one marked "being built" or "in design" moves on (row 5, and the questions).
- A piece on a solution's page changes status: a spec is agreed (planned to in design), building
  starts or a part merges (being built), it is built (built, not yet live) or goes live (ready
  today). Update its card in `src/solutions.ts` and the page's table here; for gyms, watch stages
  31 (Bookings), 32 (subscriptions, Memberships), 33 (moving from a booking system), 44
  (Agreements: signing at the desk and cooling off still to come) and 45 (Rostering: a business's own set-up still to come),
  and the question on keeping the booking system (G7).
- Staff use packs' own screens on the web in the product's admin (stage 47, ADR 0660): Bookings'
  front desk and class list, Memberships' staff view, Courses' builder, Programs' builder, exercise
  bank and coach's client view, and Rostering's screens, each listed only for whoever may use it; a
  fixed-role account (a coach, a rostered cleaner) sees just its screens. The e2e suite drives the
  desk, the class list (a coach), the roster week, offers and pay through the admin's navigation;
  the Bookings and Rostering lines in row 5 and G4 say so. The app's screens are still "not yet
  tried on phones", the web screens "not yet tried on a live host" (nothing has run on a deployed
  host behind Cloudflare Access), and the calendar address "not yet tried in phone calendars".
- Row 9 names `cos rostering import` (built and tested against a fake host and, for its check, the
  real host's operation; not yet run against a live host: say nothing more of it on the page until
  it has been).
- A new solution: an entry in `src/solutions.ts` (its page and the home card follow), a table for
  its page here, its URL in `public/sitemap.xml`, and the browser and data tests pick it up.
- The first gym goes live: G5 says it is live, in those words only, and nothing more until there
  is a real quote or case study.
- A pack goes live: its first customer uses it in production, and its payments or video have run
  against the real Stripe or Stream account. It moves from "Built, not yet live" to "Ready today"
  (row 5). Ticketing and Courses need both; Content and Programs the first.
- A merged step changes what a built pack does, in words row 5 uses (a new way to pay, a new kind
  of lesson).
- A new kind of connection ships, or one is removed (rows 6 and 10). A connection is to a system
  the company already uses. Video in Cloudflare Stream is the host's own store (stage 42, ADR
  0475), not a connection, and tax at checkout is part of the payments connection (ADR 0479), so
  neither adds one.
- The approval defaults, the sandbox or the audit log change (row 8 and the questions).
- Routine member emails (a booking's confirmation, change, cancellation and reminder) send on
  their own once the business turns automatic emails on (ADR 0590, 2026-11-23: off until a human
  admin turns them on; until then each waits for approval under the default policy): row 5 and G4
  say "by default staff approve each one until the gym turns automatic emails on". If
  routine email becomes on by default, or stops existing, both lines change. They are never
  described as written by AI or as marketing.
- The client CLI's commands change, including a new import command (row 9; `docs/deploying.md` or
  `docs/importing.md` changes with it).
- The licence changes (row 9 and the questions).
- The offer changes: what the subscription covers, the call, the reply time (rows 1, 4, 7, 11).
- Real proof arrives: Ghetto's quote and case study go in as a new section after row 5, and on the
  gym page in place of G5.
