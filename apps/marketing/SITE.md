# What the site says

A short account of composableos.dev, so nobody has to read the page's source to know whether a
change touches it. **When a change adds or alters anything below, update the page and this file in
the same PR** (`AGENTS.md`, "The site"). The decisions behind it are in
[ADR 0465](../../docs/adr/0465-the-site-sells-a-built-and-maintained-product.md).

- **The offer:** Zero BS AI builds a company's own software on Composable OS, then looks after it
  on one subscription. The toolkit itself is the second part, for developers and agencies.
- **The reader:** an owner or operations lead at a small or mid-size company.
- **The one action:** "Book a call" (`CTA` in `src/links.ts`), leading to the form at `#call`.
- **Not on the site:** prices, where a customer's product runs, a hosted CRM, a waitlist, dark
  mode, and any proof that isn't real.

## Section by section

| # | Section (component) | What it claims |
| --- | --- | --- |
| 1 | Hero (`Hero`) | Headline: "A head start on custom software to fit your business". The parts every business product needs are already built (records, rules, screens, approvals, connections); Zero BS AI composes them into the product and then looks after it. The call is 30 minutes. The picture is an invented coffee roaster's orders board with a change waiting for approval. |
| 2 | Facts bar (`Hero`) | Built for your business. Looked after by us, on one subscription. The code is yours if you want it. Your data stays yours. |
| 3 | The problem (`Problem`) | A dozen subscriptions and none is quite right: nothing quite fits, you make the concessions, nickel-and-dimed everywhere. |
| 4 | How it works (`HowItWorks`) | Three steps: tell us how you work; we compose your product; we look after it (hosting, fixes, support and changes). |
| 5 | What can go in (`Pieces`) | **Customers and sales** (people, organisations, deals, leads, pipelines, email on the timeline): ready today. **Ticketing** (events, ticket types, checkout in full or by deposit, tickets in the app, door scanning): built, not yet live (stage 27 steps 1 to 5). **Content** (blog posts, drafts, preview links, scheduled publishing, pictures, an import of old posts): built, not yet live (stage 28). **Programs** (training programs from an exercise bank, given to a person or a class, every set logged on the web and in the app): built, not yet live (stage 41). **Courses** (video lessons sold one at a time, in bundles or by a monthly subscription with a free trial, progress, only those who hold them can play them; members cancel and update their card on the web; moving subscribers from another platform still to come): built, not yet live (stage 42; the subscription is stage 32a steps 1 to 3, the move is step 4). **The part only you have:** built for that business. |
| 6 | What's inside (`Inside`) | Every product starts with: your records; your rules (stages, prices, who may see and do what, for people and AI); your screens (a web app, a mobile app when needed, for staff and customers); automations (tested before they go live); connections (email, calendars, Slack, payments); dashboards (describe a chart and get one). |
| 7 | Looked after (`Care`) | The subscription covers: hosting and keeping it running; updates to the platform; fixes; changes and new features as the business changes; support for the team. No seats, tiers or add-ons. |
| 8 | When the business changes (`Control`) | The product is changed by asking, in the app or from Claude, ChatGPT or Cursor. Admins decide what needs a person. Approved (new fields, bulk edits, deletes and outgoing emails wait for sign-off), sandboxed (no internet except through approved connections), audited (every action logged with who and why). |
| 9 | For developers and agencies (`Developers`) | The same toolkit is available: source available and free to self-host; skills that teach a coding agent to write extensions; Workers, D1 and R2 on Cloudflare. Commands: `npm create composable-os`, `pnpm cos add web-sign-in`, `pnpm cos deploy`, `pnpm cos content import` (and, named in a comment, `cos courses import`). |
| 10 | Questions (`src/faq.ts`) | The data is the customer's and they can have the code; the platform's source is public. Cost: one subscription once built, figure after the call. Leaving: they take the code and data. The AI changes only what admins allow. Connections today: email, calendars, Slack, payments, webhooks. |
| 11 | The close (`FinalCta`, `CallForm`) | The form: name, email (required), company, what you need. A reply within one working day. No newsletter, no trackers. |
| | Footer | Composable OS is built and run by Zero BS AI. |

## What the status words mean

Row 5 gives each piece one of these, and nothing stronger than the repository shows:

- **Ready today:** built, merged and tested, and either part of the platform's own product (the
  CRM) or used by a customer in production; it goes into a product as it is.
- **Built, not yet live:** built, merged and tested end to end, and it can go into a product, but
  no customer has used it yet, and anything it needs from an outside service (Stripe for payments
  and tax, Cloudflare Stream for video) has run only against the test double.
- **Being built:** part of it is merged and the rest is in progress.
- **In design:** agreed in a spec and next to be built; nothing merged yet. No piece is in design
  today: Memberships and class passes (stage 32b) wait for Bookings (stage 31), which has no spec,
  so neither is on the page.

## What changes it

- A pack or piece is added, or one marked "being built" or "in design" moves on (row 5, and the questions).
- A pack goes live: its first customer uses it in production, and its payments or video have run
  against the real Stripe or Stream account. It moves from "Built, not yet live" to "Ready today"
  (row 5). Ticketing and Courses need both; Content and Programs the first.
- A merged step changes what a built pack does, in words row 5 uses (a new way to pay, a new kind
  of lesson, Courses' subscribers moved from another platform: stage 32a step 4).
- A new kind of connection ships, or one is removed (rows 6 and 10). A connection is to a system
  the company already uses. Video in Cloudflare Stream is the host's own store (stage 42, ADR
  0475), not a connection, and tax at checkout is part of the payments connection (ADR 0479), so
  neither adds one.
- The approval defaults, the sandbox or the audit log change (row 8 and the questions).
- The client CLI's commands change, including a new import command (row 9; `docs/deploying.md` or
  `docs/importing.md` changes with it).
- The licence changes (row 9 and the questions).
- The offer changes: what the subscription covers, the call, the reply time (rows 1, 4, 7, 11).
- Real proof arrives: Ghetto's quote and case study go in as a new section after row 5.
