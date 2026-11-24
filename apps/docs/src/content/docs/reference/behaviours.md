---
title: "Behaviours"
description: "What an object may declare, enforced by the host in the write's own batch."
editUrl: false
---

A behaviour is a declarative rule set an object opts into in its manifest, enforced by the host in the same batch as the write, for every actor (ADR 0404). A pack composes behaviours; it never hooks writes. This list is read from `ObjectSpec` in `packages/sdk/src/contract.ts`, with the declarations that open records to customers and the public.

## stages

A pipeline-like stage behaviour (see StagesSpec).

Declared as `stages: StagesSpec` on an object. Declared by: [`deals.deal`](/packs/deals/data-model/).

## capacity

A limited number of places, never given out twice (see CapacitySpec, ADR 0430).

Declared as `capacity: CapacitySpec` on an object. Declared by: [`bookings.class`](/packs/bookings/data-model/), [`ticketing.event`](/packs/ticketing/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/).

## sellable

Something that can be bought, and what a paid line grants (see SellableSpec, ADR 0435).

Declared as `sellable: SellableSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/), [`courses.course`](/packs/courses/data-model/), [`courses.bundle`](/packs/courses/data-model/), [`courses.plan`](/packs/courses/data-model/), [`memberships.plan`](/packs/memberships/data-model/), [`memberships.passtype`](/packs/memberships/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/).

## stock

Things counted on a shelf, sold from a ledger the host keeps (see StockSpec, ADR 0680).

Declared as `stock: StockSpec` on an object. Declared by: no shipped pack.

## allowance

Uses a record holds (a pass, a membership), or a record that spends one (a booking): see AllowanceSpec, ADRs 0493 and 0494. The host counts and refuses a spend past the limit.

Declared as `allowance: AllowanceSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/), [`memberships.membership`](/packs/memberships/data-model/), [`memberships.pass`](/packs/memberships/data-model/).

## agreements

An agreement point (see AgreementsSpec, ADR 0641): where a business may need a person to have agreed to its documents first. The business attaches the documents; the pack names the place.

Declared as `agreements: AgreementsSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/), [`courses.course`](/packs/courses/data-model/), [`courses.bundle`](/packs/courses/data-model/), [`courses.plan`](/packs/courses/data-model/), [`courses.enrolment`](/packs/courses/data-model/), [`memberships.plan`](/packs/memberships/data-model/), [`memberships.passtype`](/packs/memberships/data-model/), [`memberships.pass`](/packs/memberships/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/), [`ticketing.ticket`](/packs/ticketing/data-model/).

## healthNotes

A health-note list (see HealthNotesSpec, ADR 0643): this object's records make a list staff read (a class's bookings), on which the host may mark a yes on someone's health form.

Declared as `healthNotes: HealthNotesSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/).

## states

A fixed state machine (see StatesSpec, ADR 0425). An object has stages or states, not both.

Declared as `states: StatesSpec` on an object. Declared by: [`bookings.series`](/packs/bookings/data-model/), [`bookings.class`](/packs/bookings/data-model/), [`bookings.booking`](/packs/bookings/data-model/), [`courses.enrolment`](/packs/courses/data-model/), [`memberships.membership`](/packs/memberships/data-model/), [`memberships.pass`](/packs/memberships/data-model/), [`programs.assignment`](/packs/programs/data-model/), [`programs.session`](/packs/programs/data-model/), [`rostering.dutyseries`](/packs/rostering/data-model/), [`rostering.shift`](/packs/rostering/data-model/), [`ticketing.event`](/packs/ticketing/data-model/), [`ticketing.ticket`](/packs/ticketing/data-model/).

## claims

A capacity claimant (see ClaimsSpec, ADR 0501): the record's own states hold, take and give back one place on the record its relation `on` points to (a booking on its class).

Declared as `claims: ClaimsSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/).

## unique

Uniqueness among live records in some states (see UniqueSpec, ADR 0502): one active booking per Person per class. Refused by the database for every actor.

Declared as `unique: readonly UniqueSpec[]` on an object. Declared by: [`bookings.coach`](/packs/bookings/data-model/), [`bookings.booking`](/packs/bookings/data-model/), [`programs.program`](/packs/programs/data-model/), [`programs.log`](/packs/programs/data-model/).

## recurring

A weekly schedule that generates dated records of another object (see RecurringScheduleSpec, ADR 0500): a timetable's series and its classes.

Declared as `recurring: RecurringScheduleSpec` on an object. Declared by: [`bookings.series`](/packs/bookings/data-model/), [`rostering.dutyseries`](/packs/rostering/data-model/).

## staffed

A shift (see StaffedSpec, ADR 0621): who works the record, when, and on what kind of work. The host refuses, in the database, one account on two overlapping shifts, and answers each write with its warnings (away, not qualified, no one on it).

Declared as `staffed: StaffedSpec` on an object. Declared by: [`bookings.class`](/packs/bookings/data-model/), [`rostering.shift`](/packs/rostering/data-model/).

## workedOn

Time can be recorded against the record (see WorkedOnSpec, ADR 0850): a job. Its time is the staff's time entries against it, read through the host; it keeps no hours of its own.

Declared as `workedOn: WorkedOnSpec` on an object. Declared by: no shipped pack.

## team

Who on the staff looks after the Person a record is about (see TeamSpec, ADR 0831): the accounts in its user fields while it is live. A pack role's `looksAfter` reaches records only for those People (ADR 0889). Only shipped extensions and an org's own may declare it.

Declared as `team: TeamSpec` on an object. Declared by: [`programs.assignment`](/packs/programs/data-model/).

## occupies

A claim on a thing (see OccupiesSpec, ADR 0765): while live, the record takes the room (or chair, or hall) it names for its time. The host refuses, in the database, a second live record on the same thing at an overlapping time, whatever object it is.

Declared as `occupies: OccupiesSpec` on an object. Declared by: [`bookings.class`](/packs/bookings/data-model/).

## calendarEntry

Events in the customer's private calendar feed (see CalendarEntrySpec, ADR 0891): the record's start, end, public title and place as paths the customer may read, and the states in which it shows. The host reads them as the customer, through the visibility seam, and shows a live dependant's to their guardian. Only shipped extensions may declare it.

Declared as `calendarEntry: CalendarEntrySpec` on an object. Declared by: no shipped pack.

## intake

The public-write door (see IntakeSpec, ADR 0720): a form the public answers, the submission the host makes from the answers, or another pack's record a form may also make. Only the host's `intake.submit` creates a submission; nothing else opens a write to the public.

Declared as `intake: IntakeSpec` on an object. Declared by: no shipped pack.

## checklists

A checklist the record's person ticks off (see ChecklistsSpec, ADR 0650): a run of the template its `template` field names, made by the host, ticked by the person (or by someone who rosters, for them), never changed once done, read only by the person and those who roster.

Declared as `checklists: ChecklistsSpec` on an object. Declared by: [`rostering.shift`](/packs/rostering/data-model/).

## customer

The object's customer (ADR 0402): whose record it is, and what that customer may read and write, field by field. `field` is a relation to one person. A signed-in customer sees only records where it is their own Person, and of those only the fields in `read`. Fields in `write` (a subset of `read`) are the ones they may set. Left out, the object does not exist for customers. Only shipped extensions and an org's own may declare it; a runtime extension fails `check`.

Declared as `customer: CustomerSpec` on an object. Declared by: [`bookings.booking`](/packs/bookings/data-model/), [`courses.enrolment`](/packs/courses/data-model/), [`courses.progress`](/packs/courses/data-model/), [`memberships.membership`](/packs/memberships/data-model/), [`memberships.pass`](/packs/memberships/data-model/), [`programs.assignment`](/packs/programs/data-model/), [`programs.session`](/packs/programs/data-model/), [`programs.log`](/packs/programs/data-model/), [`ticketing.ticket`](/packs/ticketing/data-model/).

## public

What the public may read of this object (ADR 0438): the fields in `read`, of the records that meet `when`. Deny by default: left out, the public sees nothing of it, and a record that does not meet `when` is not found. A signed-in customer reads it too, unless the object declares a `customer` (an object declares one or the other, except a publishable object with an author: see `publishable`). The public reaches it only through a pack's tool open to them (`public.list`, `public.get`). Only shipped extensions and an org's own may declare it.

Declared as `public: PublicSpec` on an object. Declared by: [`bookings.room`](/packs/bookings/data-model/), [`bookings.coach`](/packs/bookings/data-model/), [`bookings.class`](/packs/bookings/data-model/), [`content.post`](/packs/content/data-model/), [`content.category`](/packs/content/data-model/), [`courses.theme`](/packs/courses/data-model/), [`courses.course`](/packs/courses/data-model/), [`courses.bundle`](/packs/courses/data-model/), [`courses.plan`](/packs/courses/data-model/), [`memberships.plan`](/packs/memberships/data-model/), [`memberships.passtype`](/packs/memberships/data-model/), [`ticketing.event`](/packs/ticketing/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/).

## signedIn

What every signed-in customer may read of this object (ADR 0447), whoever's record it is: the fields in `read`, of the records that meet `when` (the shape of `public.when`), or of every live record without it. Beside a `customer` declaration it shares those records with every signed-in customer while each still reads and writes their own as before (a class's sessions beside a client's own); on its own it opens the records to read only (an exercise bank). Never read by the public. Only shipped extensions and an org's own may declare it.

Declared as `signedIn: SignedInSpec` on an object. Declared by: [`programs.exercise`](/packs/programs/data-model/), [`programs.classtype`](/packs/programs/data-model/), [`programs.assignment`](/packs/programs/data-model/), [`programs.session`](/packs/programs/data-model/).

## customerVia

What a customer may read of a record that one of their own records points to (ADR 0439): the fields in `read`, of the records that a record of `from` (an object of this extension that declares a `customer`) whose customer is the caller points to through its relation `field`. A ticket's holder reads its event's name, times and venue whatever the event's state. Deny by default: left out, a customer reads nothing of this object through their own records. An object that declares a `customer` cannot declare it; one that declares `public` or `signedIn` can, and a customer then reads both. Only shipped extensions and an org's own may declare it.

Declared as `customerVia: CustomerViaSpec` on an object. Declared by: [`bookings.class`](/packs/bookings/data-model/), [`ticketing.event`](/packs/ticketing/data-model/), [`ticketing.tickettype`](/packs/ticketing/data-model/).

## access

Who holds access to a record (stage 42, ADR 0477): a customer for whom one of `sources` is live (an enrolment of theirs pointing at it, or at a bundle that lists it). The parts of a document field this object's schema marks `holders` are read only by a holder; everyone else who may read the record reads it without them. The host asks one question for every read and for `media.play`; a block, a hook or a client app is only told the answer. Only shipped extensions and an org's own may declare it.

Declared as `access: AccessSpec` on an object. Declared by: [`courses.course`](/packs/courses/data-model/).

## publishable

A working copy staff edit and published versions (ADR 0446): `content` names the fields a version keeps. `record.publish` snapshots them as the next version (a person with the publish permission, never an AI actor); `record.versions` and `record.version` read them; `record.restoreVersion` copies one back into the working copy. Editing the working copy never changes a version. Records get read-only `publishedVersion` and `publishedAt`. With an author (ADR 0810): a publishable object may declare a `customer`, the record's author (a review's writer). The author reads and writes their working copy through `customer`; the public reads only the published version through `public` (which may then be declared too), listed by `content.list` and never by an address (no `slug`). The fields in `customer.write` are the author's alone: staff, the assistant, MCP clients, automations and the extension's own code are refused them on every path, so a published version is always the author's words. Staff still publish, unpublish and move the record's states.

Declared as `publishable: PublishableSpec` on an object. Declared by: [`content.post`](/packs/content/data-model/), [`courses.course`](/packs/courses/data-model/), [`courses.bundle`](/packs/courses/data-model/), [`programs.program`](/packs/programs/data-model/).
