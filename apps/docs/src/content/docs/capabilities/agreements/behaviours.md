---
title: "Agreements: behaviours"
sidebar:
  label: "Behaviours"
  order: 3
editUrl: false
---

## agreements

An agreement point (see AgreementsSpec, ADR 0641): where a business may need a person to have agreed to its documents first. The business attaches the documents; the pack names the place.

Declared on: [`bookings.booking`](/packs/bookings/data-model/), [`courses.course`](/packs/courses/data-model/), [`courses.bundle`](/packs/courses/data-model/), [`courses.plan`](/packs/courses/data-model/), [`courses.enrolment`](/packs/courses/data-model/), [`memberships.plan`](/packs/memberships/data-model/), [`memberships.passtype`](/packs/memberships/data-model/), [`memberships.pass`](/packs/memberships/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/), [`ticketing.ticket`](/packs/ticketing/data-model/). [The behaviour's reference](/reference/behaviours/#agreements).

## healthNotes

A health-note list (see HealthNotesSpec, ADR 0643): this object's records make a list staff read (a class's bookings), on which the host may mark a yes on someone's health form.

Declared on: [`bookings.booking`](/packs/bookings/data-model/). [The behaviour's reference](/reference/behaviours/#healthnotes).
