// Solutions: the whole system for one kind of business, each on its own page at
// /solutions/<slug>/ (src/pages/solutions/[slug].astro), and listed on the home page
// (Solutions.astro). Every piece carries a status word from status.ts, as true of the repository
// today; SITE.md says what each page claims and where it comes from. Only solutions that exist
// are listed: no placeholders.
import type { Status } from "./status.ts";

export interface SolutionPiece {
  title: string;
  body: string;
  status: Status;
}

export interface Solution {
  slug: string;
  /** The name on the site: the home page's card, the page's eyebrow. */
  label: string;
  /** The home page's card. */
  summary: string;
  /** The home page card's link. */
  linkLabel: string;
  /** The page's <title> (50 to 60 characters) and meta description (150 to 160). */
  title: string;
  description: string;
  heading: string;
  lead: string;
  facts: readonly string[];
  problem: { heading: string; pains: readonly { title: string; body: string }[] };
  pieces: {
    heading: string;
    lead: string;
    /** What is built, ready or not yet live. */
    built: readonly SolutionPiece[];
    /** What is being built, in design or planned. */
    notYet: readonly SolutionPiece[];
    /** What the reader keeps until the pieces still to come exist. */
    notYetNote: string;
    /** The last built card: the piece only this business has. */
    own: string;
  };
  /** The first business of this kind being moved onto the platform: its name only. */
  first?: { eyebrow: string; name: string; heading: string; body: string };
  questions: readonly { q: string; a: string }[];
  call: { heading: string; lead: string };
}

export const SOLUTIONS: readonly Solution[] = [
  {
    slug: "gyms",
    label: "For gyms and studios",
    summary:
      "Events, online courses, training programs and your blog in one system, with class bookings and memberships still to come. Each piece says how far along it is.",
    linkLabel: "See the system for gyms",
    title: "Gym and studio software, looked after · Composable OS",
    description:
      "One system for your gym or studio: events, online courses, training programs and your blog on your own site and app. Built for you, looked after. Book a call.",
    heading: "Gym and studio software, built around how you run yours",
    lead: "Events, online courses, training programs and your blog in one system, on your own site and app, with class bookings and memberships still to come. Zero BS AI composes it for your gym, then looks after it on one subscription.",
    facts: [
      "Every member is one record, not five",
      "Your own site and app",
      "Looked after by us, on one subscription",
      "Your data stays yours",
    ],
    problem: {
      heading:
        "A booking system, a course platform, ticketing, a website and a programming app. None of them talk to each other.",
      pains: [
        {
          title: "A bill for every job",
          body: "Each tool does one thing and charges for it. Add a camp or a course and there is another subscription.",
        },
        {
          title: "The same member, five times",
          body: "Someone who comes to classes, buys a course and books a camp is a different record in each tool. Nobody sees the whole person.",
        },
        {
          title: "Gaps filled by hand",
          body: "Who paid, who has access and who is coming gets copied between systems and checked in a spreadsheet.",
        },
      ],
    },
    pieces: {
      heading: "The whole system, and how far along each piece is.",
      lead: "Every piece works on the same members, payments and rules. The built ones are tested and can go into your system now; none is live at a gym yet.",
      built: [
        {
          title: "Members and enquiries",
          body: "Every member, ticket buyer, student and enquiry is one person, with their history and emails in one place.",
          status: "ready",
        },
        {
          title: "Events and camps",
          body: "Ticket types with their own places, paying in full or by deposit, tickets in your app, and scanning at the door.",
          status: "built",
        },
        {
          title: "Online courses",
          body: "Video lessons sold one at a time or in bundles, on your site and in your app, with progress. Only people who paid can play them. Your courses and students come across with an import.",
          status: "built",
        },
        {
          title: "Course subscriptions",
          body: "One monthly subscription to every course, including ones added later, with a free trial for each person, paid through your own Stripe account. Members cancel and update their card on your website.",
          status: "built",
        },
        {
          title: "Moving your course subscribers",
          body: "Your current subscribers sign in on your site and continue, free until the date they have already paid up to, then charged. A list shows who has moved, so you end exactly those old subscriptions.",
          status: "built",
        },
        {
          title: "Training programs",
          body: "Programs built from your exercise bank, given to a member or a whole class, with every set logged against its target. Your exercises, programs and members' past training come across with an import.",
          status: "built",
        },
        {
          title: "Your blog",
          body: "Posts with drafts, preview links and scheduled publishing, on your own site. Your old posts come across with an import.",
          status: "built",
        },
      ],
      notYet: [
        {
          title: "Class bookings",
          body: "Classes made from your weekly timetable, booked and cancelled on your site and app within each class type's rules: when booking opens and closes, when a cancel is late, and classes only staff book. A full class has a waiting list: a place freed in time goes to the first person waiting who has a membership or pass to pay with, moved in on their own and paid from it then. Parents the gym has linked to their children book, cancel and join the waiting list for them, paid from the child's own membership or pass. A visitor, or a member with nothing to book with, pays for a single class on your website, no account needed, their place held while they pay and booked once the payment goes through; cancelled in time, the money goes back to their card once a member of staff approves it, and cancelled late, it is kept. Staff book anyone, walk-ins too, move a member to another class with the class it used, and cancel a class before it ends, giving everyone who booked it with a membership or pass that class back, including anyone already ticked or who cancelled late, and refunding anyone who paid for it on your website to their card once a member of staff approves it. Members, and parents about their children, are emailed when they book, with a file that adds the class to their calendar, when the gym changes the time or room or cancels their class, and with a reminder a few hours before it (3 by default, set per class type), by default your staff approve each one until the gym turns automatic emails on, and an admin can turn any of these emails off. Coaches tick who came on the class list in your app; a no-show keeps the class used. On the web, your staff work the front desk and the class list in the product's admin, and a coach signs in there to just the class list; the web screens are not yet tried on a live host. Still to come: one-to-one sessions booked by staff.",
          status: "building",
        },
        {
          title: "Memberships and passes",
          body: "Monthly memberships, unlimited or a number of classes a week or month, and passes bought once: class packs that expire, drop-ins and an intro offer, one per person. Members see what they have left, used up as they book classes, and change plan on your website: a dearer plan at once, a cheaper one from the next billing period. Staff pause a membership for a set time, with nothing charged meanwhile.",
          status: "building",
        },
        {
          title: "Rostering",
          body: "Which coach takes each class, and who does each shift that is not a class, like the clean after the last class. A weekly pattern makes the shifts eight weeks ahead and you change single dates; nobody is ever on two shifts at once. Staff say when they are away and offer a shift they cannot work: a colleague who may coach that class type takes it with nobody approving, and you are told. A duty like the closing clean can carry a checklist the person on the shift ticks off. Checklists also work on their own, before any roster: opening, closing and cleaning, due on set days by a set time, ticked off by whoever you choose (a cleaner or a coach too); you see how each day went, who ticked what and when, and you are told when one is missed. Members still see only the coach's public profile: name, photo and bio. For staff paid by the hour or by the class, each pay period's hours and classes are totalled from the roster and locked, with a file for payroll, and each of them can see their own; no pay rates are kept. Staff see their own shifts, take offered ones, say when they are away and get a private calendar address for their phone's calendar; you see the roster week, put people on shifts, set the regular week, who may coach what, everyone's time off and pay. Staff use the screens on the web in the product's admin, each person seeing only the ones they may use, and in the app (not yet tried on phones); the web screens are not yet tried on a live host, and the calendar address is not yet tried in phone calendars.",
          status: "building",
        },
        {
          title: "Waivers and agreements",
          body: "Your membership terms, waiver, health questions and a parent's consent, in your own words. Members read and agree on your site or in your app, by ticking and typing their name or by drawing a signature, as you choose for each document. A visitor agrees on the way to paying for a class, and a parent agrees for their child. Nobody books a class or buys a membership or pass without agreeing first, and when you change a document you choose whether everyone agrees again before their next booking. A copy goes by email to whoever agrees online, and you can download the signed PDF at any time. Health answers are read only by the staff you allow; a coach sees a mark beside the name, never the answers. The screens in your app are built but not yet tried on phones. You can set a cooling-off period: a new member can end their membership on your website inside it, once, and what they paid in that period is refunded once a member of staff approves it (not for members moving over from another system). Still to come: signing on the gym's own tablet at the desk.",
          status: "building",
        },
        {
          title: "Moving from your booking system",
          body: "Your clients, visit history, passes and schedules brought across, with a time when both run side by side.",
          status: "planned",
        },
      ],
      notYetNote:
        "Class bookings, memberships and passes, and the move from your booking system are what would replace it. None is finished yet, so until they are, your booking system stays.",
      own: "The thing no software does the way your gym does it. We build that piece for you.",
    },
    first: {
      eyebrow: "The first gym",
      name: "Ghetto Movement",
      heading: "Ghetto Movement is being moved onto it.",
      body: "It is the first gym moving onto Composable OS, and it is not live yet.",
    },
    questions: [
      {
        q: "Can we keep our booking system for now?",
        a: "Yes. Class bookings and memberships are being built, so your booking system stays while the rest moves. Moving from it comes after both are built.",
      },
      {
        q: "Can members use it on their phones?",
        a: "Yes. Tickets, courses and training programs each have screens for your own app as well as your website.",
      },
      {
        q: "Who takes the payments?",
        a: "Your own Stripe account. Nothing on the platform charges a card on its own.",
      },
      {
        q: "What does it cost?",
        a: "Once it's built, one subscription that covers hosting, updates, fixes, changes and support. The figure depends on what we compose for your gym, so you get it after the call.",
      },
    ],
    call: {
      heading: "Tell us how your gym runs.",
      lead: "Zero BS AI will tell you what we'd compose for it, what is built and what it would take.",
    },
  },
];
