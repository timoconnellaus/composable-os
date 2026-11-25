---
title: "A company's own product"
description: "A client repository's product definition and the packs it can turn on."
editUrl: false
---

A company's own product lives in its own repository, made with `cos create` or adopted with `cos init` from the client template ([templates/client](https://github.com/timoconnellaus/composable-os/tree/main/templates/client)). Its `product.ts` lists the packs that are on (none by default: base records only) and `cos deploy` installs them. Any pack the release carries can be listed:

| Pack | What it is |
| --- | --- |
| [Bookings](/packs/bookings/) | A timetable of classes made from weekly series, rooms and coaches, and the bookings members make and cancel within the gym's rules. |
| [Content](/packs/content/) | Blog posts and their categories: staff write and schedule them, a person publishes them, and the public reads what was published, on the web and in the app. |
| [Courses](/packs/courses/) | Video courses sold one at a time or in bundles, watched lesson by lesson, with progress. |
| [Daily checklists](/packs/dailychecks/) | Checklists done on their own: opening, closing and cleaning, due on set days by a set time, ticked off by whoever may do them, with how each day went for those who manage them. |
| [Deals](/packs/deals/) | Deals moving through pipelines of stages, with stage rules, probabilities, stage history and the people involved. |
| [Forms](/packs/forms/) | Forms the business builds and publishes (enquiries, sign-ups, surveys, feedback, staff reports), and every answer in one inbox, linked to the person who sent it. |
| [Leads](/packs/leads/) | Inbound interest linked to a person and an organisation, worked from a leads inbox, qualified or disqualified, and converted into deals. |
| [Lifecycle stage](/packs/lifecycle/) | A lifecycle stage on every person (subscriber, lead, marketing qualified, sales qualified, opportunity, customer, evangelist, other), tracked on the timeline, with a board of people by stage. |
| [Memberships](/packs/memberships/) | Membership plans paid every month and class passes bought once, with what each allows and what a member has left. |
| [Programs](/packs/programs/) | An exercise bank, programs built from it as one layout (weeks, sessions, blocks, items, levels, typed sets), published versions, assignments to a person or a class type as dated sessions, and a log of every set against its target. |
| [Rostering](/packs/rostering/) | Who works when: duties that are not classes, their weekly pattern and dated shifts, and the roster of every shift, with offers, takes and time off. |
| [Shop](/packs/shop/) | One list of the things the business sells, in their versions, sold online, in person or both, with stock the host keeps, ways to get an order to its buyer, and the shipments staff pack and send or hand over. |
| [Ticketing](/packs/ticketing/) | Events, ticket types for sale and the tickets a paid order grants, with check-in at the door. |
