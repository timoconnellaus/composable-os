# Stage 51: Kiosk check-in (the enrolled device, and checking in at the door)

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Booking, Class list, Coach, Desk permission, Desk signing
session, Device session, Pack role, Permission grant, Check-in, Code, Health form), stage 44's
[Signing at the desk](44-agreements.md#signing-at-the-desk-decision-22) (the enrolled tablet, the
desk origin, its limits) and its step 6, stage 47 ([pack screens](47-pack-screens.md)), stage 48
(My account, PR [#311](https://github.com/timoconnellaus/composable-os/pull/311), branch
`docs/stage-48-my-account`), ADRs [0402](../adr/0402-staff-and-customers.md) (audiences),
[0419](../adr/0419-native-sessions-and-customer-sign-in.md) (the app's device sessions),
[0436](../adr/0436-pack-roles-and-the-door-role.md) (pack roles, the door role),
[0437](../adr/0437-a-move-is-made-from-a-current-read.md) (a move from a current read),
[0540](../adr/0540-the-family-link.md) (the family link),
[0550](../adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md) (no-shows),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (attendance),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) (fixed-role accounts and grants),
[0643](../adr/0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)
(health marks), [0644](../adr/0644-enforcement-nobody-pays-or-books-without-what-is-due.md)
(enforcement), [0320](../adr/0320-erase-reaches-every-store.md) (erase); issues
[#236](https://github.com/timoconnellaus/composable-os/issues/236) (check in by a member's code,
which this stage closes) and [#118](https://github.com/timoconnellaus/composable-os/issues/118)
(offline writes, not built here).

Status: **spec agreed** (no interview was held: the ten questions were decided by the coordinator
on 2026-11-24 under the owner's standing rule that best-practice answers are decided, not asked;
decisions 1 to 10 below, each open to override). Roadmap stage 51. Build may start with step 1.

**Shared piece owned here.** This stage defines the **enrolled device** (a tablet or other device a
human admin enrols as the business's own, what it may do, and how it is revoked) once. Desk signing
(stage 44 step 6), the Till (stage 50) and the check-in tablet all use it, and none of them defines
its own. Stage 44 already designed the enrolment for desk signing; this stage keeps that design and
makes it general (below, [The enrolled device](#the-enrolled-device-the-shared-piece)).

**A word.** CONTEXT.md says to avoid "kiosk" for the desk signing tablet, meaning "a standing
sign-in on a shared device". Nothing here is that either: the check-in tablet holds no sign-in of a
person and reads no one's record. The stage keeps the name it was given; the vocabulary the build
adds to CONTEXT.md is **Enrolled device**, **Device role**, **Check-in tablet** and **Person's
code**, and the **Check-in** entry (today Ticketing's) is widened to "checked in at the door".

## Goal

A gym puts a tablet by the door. A member walking in holds up the code in their app (or a card, or
types their name and a PIN), and the tablet checks them in to the class they booked, or to open
gym, and says "Welcome, Sam: 6 pm Strength". That check-in is the same record as the coach's tick:
the coach's list shows the member as come, and nobody ticks them again. A member who cannot be let
straight in (nothing to pay with, a document to agree to) is told one neutral line, "Please see the
desk", and the reason goes to staff, not to the people standing behind them. The tablet is the
business's own device, enrolled by an admin, signed in as nobody, and able to do almost nothing: it
cannot list members, show anyone's record, or be used for anything but checking a person in.

## Who it is for

**Gyms and studios first.** Members arriving for a class they booked, members using open gym with
no class, families (a parent checking in their children, or a teenager arriving alone), and
visitors (who are sent to the desk). It saves the coach ticking names at the start of a busy class,
and it gives open gym a record of who came, which nothing records today (there is no booking to
tick).

**Trades and services next.** What they would need from it:

- **The same pieces**: the enrolled device and the person's code. A salon, a clinic or a car service
  drop-off checks a customer in for their appointment; a trade business signs workers in and out
  at a site.
- **What differs**:
  - **Services** check in to an appointment (stage 31b), not a class, and need "your practitioner
    has been told you are here" more than a class list.
  - **Trades** sign *staff* in to a shift or a site, which is a time entry (Timesheets and leave,
    stage 58, owns time entries), not a booking. They also need signing *out*, and a site induction
    agreed first (stage 44's agreements).
- Neither is built here. A device role is declared by a pack, so an appointments or a timesheets
  pack can declare its own check-in role and tool later (Out of scope).

## What exists today (from the code, checked 2026-11-24)

- **Attendance is the coach's tick** (ADR 0553): `markAttended`, `undoAttended`, `markNoShow` and
  `markAll` in `packs/bookings/tools.ts`.
  - The booking records `markedAt`, `markedBy` and `markedByName`, set from `ctx.caller`, never
    from the input.
  - Of two ticks at once, one is made and the other answered `already` (ADR 0437).
  - The list opens an hour before the class (`listOpens` in `packs/bookings/index.ts`:
    `minutesBefore: 60`).
  - 30 minutes after a class ends the host makes the still-booked bookings no-shows, only if
    someone on the class was ticked (`states.after`, ADR 0550). A check-in at the door counts as
    that tick.
- **Ticketing's door check-in** is the scanning precedent (`checkIn` and `normaliseCode` in
  `packs/ticketing/tools.ts`, the door role in `packs/ticketing/index.ts`):
  - A QR carries only a long random code.
  - The answer is one of `accepted`, `already_used`, `void` or `unknown`, each with its own words.
  - Of two scanners at once one is accepted, and the check-in stores who scanned.
  - The code is the *ticket's*, and the scanner is a person signed in with the door role.
- **Pack roles and grants** (`packages/core/src/pack-roles.ts`: `loadPackRole`, `staffAuthority`,
  `roleLimitsFor`, `packRoleReaches`; ADRs 0436 and 0600). A fixed role holds only its pack's
  tools and reads, enforced by the pipeline before the input is parsed. Only *user accounts* hold
  them today.
- **Who started a tool** (`StartedBy` in `packages/sdk/src/contract.ts`) is `staff`, `customer` or
  `public`, and `TOOL_AUDIENCES` is the same three. There is no caller kind for a device.
- **The enrolled desk tablet** (stage 44 step 6) is **designed, not built**: no migration, table or
  operation exists for it yet. Its design: `core_agreement_desk_device`, enrolled by an admin with
  every admin told, a credential kept as an HMAC and rotated on each claim with a 60-second grace,
  a clone revoking it, 30 days unused lapsing it, the browser and network recorded and a change
  flagged; the desk origin (`desk.` before the host's name), its cookies and the `Origin` check;
  its credential alone opens nothing, because a staff member starts each signing session.
- **What lets a member in**: their membership or pass (`packages/core/src/allowance/`), spent when
  a booking enters `booked`. A membership past due still gives for a grace period
  (`GIVING_STATES` and `PAST_DUE_GRACE_DAYS` in `packages/core/src/subscriptions/access.ts`).
- **Agreement enforcement** (`enforceEntry` in `packages/core/src/agreements/enforce.ts`) asks when
  a booking is created in a state that counts (booked, waiting, or made straight into attended)
  and when it moves into one. A move between two states that both hold the place (`booked` to
  `attended`) is the same booking and is not asked, so "agree again" never refuses a tick.
- **Health marks** (ADR 0643): `agreement.healthNotes` gives a yes or no per Person, only to staff
  with `agreements:health`, only inside a tool a person called. `roster` and `classList` carry it.
- **The app's own sign-in** is a device session (ADR 0419, `core_device_session`): the member's
  phone, not the business's. Unrelated to the enrolled device beyond the word.
- **Offline**: retries with the same idempotency key are covered (stage 23); a queue of writes made
  while offline is not (issue #118).
- **Nothing exists for a person's own code.** A Person has no code, no card and no PIN. Grants have
  codes (tickets); people do not. The host holds no date of birth (migration 0851's note).

## Decided by the coordinator (2026-11-24)

No interview was held. Each question the draft raised was decided as best practice under the
owner's standing rule; each is open to override by the owner.

| # | Decision |
| --- | --- |
| 1 | **How members arrive today** (marked, cards, who is at the door) was not asked: the design's assumptions stand, to be checked with the business during setup |
| 2 | **Three ways to check in**: the code shown in the member's app (it changes every 30 seconds, so a screenshot sent to a friend stops working), a card or key tag the gym gives them, or their full name and a 4-digit PIN they choose in the app |
| 3 | **On success the tablet shows their given name and the class**: "Welcome, Sam: 6 pm Strength". Never a full name |
| 4 | **A membership past due but still in its grace period lets them in**, and the screen says nothing; staff see it on the door list |
| 5 | **A booked member with a document now due** (the gym asked everyone to agree again) **is not checked in**: the tablet says "Please see the desk", and staff can start a desk signing session for them |
| 6 | **Offline, the tablet says "We can't check you in right now: your coach will tick you in"**, and the coach ticks names as today. Nothing is queued |
| 7 | **Walking in without a booking** is allowed only for the kinds of class the gym marks as walk-in (such as open gym), where there is a place and their membership or pass covers it |
| 8 | **A visitor with no membership or pass** is told "Please see the desk", and nothing else |
| 9 | **A child may check themselves in**, with their own card, their own app code (a child with their own sign-in), or their parent's app code |
| 10 | **Check-in closes 15 minutes after a class starts** (a setting). It opens an hour before, as the coach's list does |

## The design in one page

- **One enrolled device, defined here, used three ways.** An admin enrols a device for one **use**:
  desk signing (stage 44), a **device role** (check-in here), or a till (stage 50). The enrolment,
  the credential, rotation, clone detection, lapsing, revocation, the notices to every admin and
  Settings → Devices are built once, in step 1, as stage 44 designed them.
- **What the credential alone may do depends on the use**, and is never more than this:
  - **Desk signing**: nothing but claim a session a staff member started (stage 44, unchanged).
  - **A device role**: exactly that role's tools, with no person starting a session. Bookings
    declares the role `bookings.checkin` (two tools).
  - **A till**: nothing by itself. Staff sign in as themselves; the credential only says which
    device the call came from. Stage 50 decides the rest.
- **A device is a new kind of caller.** Device-role tools see
  `ctx.caller = { kind: "device", deviceId, name }` and are open to a new audience, `device`, on the
  desk origin only.
- **The member identifies themselves** in one of three ways (decision 2), resolved by the host,
  never by the page. The device never holds a Person id: the host answers choices and a short
  handle, bound to that device, good for one check-in.
- **The tablet checks them in** through Bookings' `checkInHere`. The host's rules decide:
  - **Booked into a class whose check-in window is open**: the booking moves `booked` to
    `attended`, the coach's tick, recorded as marked by the device ("at the door").
  - **A walk-in class** (decision 7): one batch makes the booking and ticks it, so a use is spent
    and a place held as for any booking, and the host refuses it when there is no place, nothing to
    pay with, or a document due.
  - **Several open at once** (a parent and children, two back-to-back classes): the tablet shows
    only *this* person's own choices by class name and time, and their dependants' given names.
- **The screen says one thing to the room**: "Welcome, [given name]: [class] at [time]", or "Please
  see the desk". It never says why. The reason goes to Bookings' **At the door** staff screen, for
  staff allowed to see it. A health note is never a reason, never shown and never read.
- **The coach's list is unchanged in shape.** A door check-in shows as ticked, "at the door"; the
  coach can undo it as any tick.
- **Offline, it says so** (decision 6). It stores nothing about members and queues nothing.
- **Nothing here is for an AI.** Enrolling, giving a device its use, issuing cards and setting a PIN
  are a person's acts; device tools are callable only by an enrolled device.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A check-in staff account** (a fixed-role user signed in on the tablet, ADR 0600 style) | A user account is a person's: its sign-in is by someone's mailbox, it lives on the staff origin, and "who marked it" would name a person who was not there. Stage 44 rejected the same for signing. A device with its own origin, credential and role says what it is |
| **Staff start each check-in session** (stage 44's desk model) | Right for signing a document, wrong for a door: thirty members arrive in five minutes |
| **A second enrolment for check-in** (or for the till) beside stage 44's | Two enrolment flows are two attack surfaces and two Settings pages. One device primitive, one use per device |
| **One device holding several uses at once** (a tablet that checks in *and* takes signing sessions) | Each use is its own authority, and joining them puts a staff-started signing screen behind a door screen anyone can touch. One use per device to start; an admin changes a device's use in a minute. Joining is later |
| **The device passes a Person id to the tool** | A device that can name any Person id can probe the member list. The host identifies, and the device holds only an opaque handle good for one check-in |
| **A static code in the app** | A screenshot sent to a friend works for ever. A fixed code is kept for cards, where a lost card is reported and revoked |
| **Name search with a list of matches** | Anyone at the tablet could page through the members. An exact name with a PIN, or nothing |
| **Name with a date of birth, or with phone digits** | The host holds no date of birth and should not start for this; phone digits are guessable from a contact list. A PIN is new, the member's own, and says nothing about them |
| **The tablet shows the reason** ("Your payment failed") | Other members are standing behind (decision 4). The member sees their own reason on their phone, in My account's "Needs your attention" |
| **Queue check-ins on the tablet while offline** | Decision 6. The tablet would hold members' codes and times, and replaying them meets classes that have started, filled or been cancelled (issue #118 is not built) |
| **The tablet creates people, or sells a drop-in** (a visitor typing their details, or a QR to the website) | Decision 8. A public device making records is a spam and duplicate source; the desk books a walk-in and takes payment as it does today |
| **The door check refuses a booked member with a document due through the engine** (enforcement on the `booked` to `attended` move) | That would refuse the coach's tick too, and ADR 0644 deliberately keeps "agree again" off a tick. Decision 5 is the door's policy, asked in the door's tool; the coach can still let the member in |
| **NFC cards and phone taps** | Needs a native app on the tablet, and the web's NFC is on one browser family only. Barcode and QR cards with the tablet's camera, or a plug-in scanner that types, are enough to start |

## Platform work and pack work

| Piece | Kind | Why |
| --- | --- | --- |
| **The enrolled device**: `core_device`, its use, enrolment, the credential, rotation, clone detection, lapsing, revocation, every admin told, the desk origin's `/enrol`, Settings → Devices | **Platform** (shared with stage 44 step 6 and stage 50) | Built once; identity and devices are not a pack's |
| **A device as a caller**: `StartedBy` and `ctx.caller` gain `{ kind: "device", deviceId, name }`; the `device` audience; the pipeline's device check on the desk origin only | **Platform** (new principal) | A device is not staff, a customer or the public |
| **Device roles**: a pack declares `deviceRoles`; an admin gives an enrolled device one; the pipeline decides its calls as `staffAuthority` does a pack role's | **Platform** (extends ADR 0436) | "A role is all it may do", for a holder that is not a person |
| **The person's code**: `core_person_code` (an app secret per signed-in app, and cards), the rotating code, `me.code`, cards issued and revoked by staff, identification (device only) | **Platform** (new primitive) | A Person's, not a pack's: any pack's check-in uses the same code |
| **The PIN**: `me.pin.set` and `me.pin.clear`, a slow hash, name and PIN identification with lock-outs | **Platform** | Part of identifying a person, kept in the host |
| **A device screen**: a device role names its screen, built into the desk origin's bundle (stage 47's build pattern), served there and nowhere else | **Platform** (extends stage 47) | Stage 47's screens live in the admin; a device's must live on the device's origin only |
| **The door log**: `core_device_event` (each attempt's outcome, reason category, the Person and booking when identified, the device), purged after a set time, erased with the Person | **Platform** | Reasons for staff, without putting them on a booking; pack code cannot keep a log of people's refusals in its own storage |
| Bookings: the `bookings.checkin` device role; `doorNow`, `checkInHere` and `doorLog`; the class type field "walk in at the door"; the closing window setting | **Pack** | Composes the existing move and `record.create` of a booking; the host's allowance, capacity, agreements and windows do the rest |
| Bookings: the "At the door" staff screen (a stage 47 screen) and "at the door" on the class list | **Pack** | Existing blocks extended |
| The member's check-in code and Set a PIN, as a base section of My account (stage 48), web and native, one hook | **Base-layer blocks** | Not a pack's; stage 48 says a customer's view of a module is a section of My account |
| Settings → Devices (enrol, use, revoke), Cards on the Person page | **Core admin screens** | Identity and devices |

## The enrolled device (the shared piece)

Step 1 builds this. It is stage 44's design for the desk tablet, generalised; everything stage 44
says about its desk tablet holds for every enrolled device unless this section says otherwise.

### The record

`core_device` (`dev_…`) replaces stage 44's planned `core_agreement_desk_device` (not built):

- its **name** ("Front door tablet");
- its **use**: `signing` (stage 44's desk sessions), `role` with the **device role** it holds
  (`bookings.checkin`), or `till` (stage 50);
- who enrolled it and when, when it was last seen, who revoked it and when, and why (`admin`,
  `clone`, `lapsed`);
- the browser (user agent) and the network address at enrolment and at each rotation, and the
  flags a change raises on the devices list. As stage 44 says, this does not go against its
  decision 3: these describe the business's own tablet and premises, not a member's device;
- the credential, kept only as an HMAC under an env secret, with the previous credential's HMAC and
  when it was rotated away (for the grace window).

### Enrolling

- **`device.enrol { name, use, role? }`**: an admin, a person (`actors: ["human"]`), no grant can
  give it. The host answers an **enrolment code**: 10 characters, single use, valid 10 minutes,
  stored only as an HMAC.
- On the tablet the code is typed at `/enrol` on the origin the use lives on (the desk origin for
  signing and a device role). **`device.claim { enrolmentCode }`** (public audience, that origin
  only, rate-limited) sets the **device credential**: 256 random bits in a cookie that is
  `HttpOnly`, `Secure` and `SameSite=Strict`, on that origin only, never in a URL or shown.
- **Every admin is told** at once, in the host and by email: "[admin] enrolled a device, [name],
  for [use], at [time]". They are told again when a device's use or role changes, and when one is
  revoked or revoked as a clone.
- **`device.setUse { deviceId, use, role? }`** (an admin, a person, audited before and after)
  changes what an enrolled device is for. It ends any open signing session on it in the same batch.

### Rotation, clones and lapsing

- **Stage 44's rule stands for signing**: every session claim rotates the credential.
- **Every device also rotates at least once a day**: the first call more than 24 hours after the
  last rotation gets a new credential in its response.
- **A grace window of 60 seconds**: the credential just rotated away is still accepted for 60
  seconds, and a retry of the rotating call gets the same new credential. A door tablet makes
  several calls at once, and a lost response must not lock it out.
- **A clone**: a credential rotated away and presented after the grace window means two browsers
  hold it. The host revokes the device and tells every admin.
- **Lapsing**: a device with no call for 30 days lapses, and an admin enrols it again. A check-in
  tablet in use calls `device.heartbeat` every few minutes, so it lapses only when switched off for
  a month.

### Revoking and loss

- **`device.revoke { deviceId }`** (an admin, a person, risk `destructive`) revokes it at once and
  ends any open signing session on it in the same batch. Its next call is refused.
- **Settings → Devices** replaces stage 44's Settings → Agreements → Desk tablets. It lists every
  device: name, use, role, enrolled by, last seen, flags, lock-outs; enrol, change use, revoke.
- **A lost tablet** holds no member's data, and once revoked it opens nothing.

### What the credential may do, by use

| Use | Alone, the credential may | Needs as well |
| --- | --- | --- |
| `signing` | Show "Enter code" and call `desk.claim` | A staff member's session and its token for everything else (stage 44, unchanged) |
| `role` | Call its device role's tools, `device.heartbeat`, and nothing else | Nothing: each call stands alone |
| `till` | Nothing | A staff member signed in as themselves; the credential names the device on their calls (`ctx.device`). Stage 50 decides what a till device does |

- **The origin.** Signing and device-role devices live on the desk origin, which serves only desk
  pages and desk and device calls, and serves none of them on the staff origin. A deployment that
  cannot add the desk hostname has no desk signing and no check-in tablet; it does not fall back
  to the staff origin. A till's screens are staff screens; if stage 50 enrols a till on the staff
  origin, the same enrolment runs there with its own cookie, and the credential on the staff origin
  is only ever an identification, never authority.
- **Every device write checks `Origin`**, and a device call that arrives with a staff session is
  refused (stage 44's hygiene rule).

### What stage 44 step 6 takes from this

Stage 44 step 6 is about to be built. To keep one device:

- **If step 6 is built first** (expected), its session builds `core_device` as above (use `signing`
  only), with `device.enrol`, `device.claim`, `device.revoke`, the daily rotation and Settings →
  Devices, instead of `core_agreement_desk_device` and `agreement.desk.enrol`/`revoke`. Its own
  session tables, codes, tokens, limits and calls (`desk.claim`, `desk.documents`, `desk.accept`,
  `desk.heartbeat`, `desk.finish`) are unchanged and stay on the public audience as stage 44 says.
  Step 1 here then adds only the `role` use (and `till` reserved).
- **If step 1 here is built first**, step 6 uses it and adds its sessions.
- Either way, the table and enrolment are written once. Whichever builds `core_device` uses its own
  block's migration number. The stage 44 spec gets a dated note naming this section when step 6
  is built.

## The model

### Records

| Record | What it holds |
| --- | --- |
| `core_device` (`dev_…`) | Above |
| `core_person_code` (`pc_…`) | The Person; kind `app` or `card`. For a card: the code's HMAC and a label ("blue key tag"), who issued it and when. For an app: the secret, encrypted under an env key (the host must check a rotating code), tied to the member's app sign-in (`core_device_session`), so it ends when that sign-in ends. When last used, when revoked |
| `core_person_pin` | The Person, a slow hash of the PIN, when set, wrong tries counted. At most one per Person |
| `core_device_handle` | A short-lived handle from `doorNow`: its HMAC, the device, the Person and the choices offered, expiring after 60 seconds, used once |
| `core_device_event` (`dve_…`) | The door log: the device, when, the outcome (`checked_in`, `see_desk`, `not_found`, `locked`, `already`), the reason category for `see_desk`, the Person and booking when identified. No code, no PIN, no name typed |
| `bookings.booking` (existing) | Unchanged fields. A door check-in sets `markedBy` to the device id and `markedByName` to the device's name |
| `programs.classtype` (Bookings' fields, existing) | New: **walk in at the door** (yes or no) |

### Identifying a person

The host's `identify` step, run inside `doorNow` (never its own call from the page):

- **An app code**: the QR carries the code's id and a value made from the secret and the current
  30-second step. The host accepts this step or the one before (so a code is good for at most 60
  seconds). The native app makes it offline from the secret it holds in the phone's secure
  storage; the web account page asks `me.code` for the current value and holds no secret.
- **A card**: its fixed long code, compared by HMAC. A revoked card gives nothing.
- **A full name and a PIN**: the name is compared case-folded, accents folded and spaces
  normalised against the Person's given and family names; the PIN against its slow hash. Exactly
  one Person matching both, or nothing. Nothing is listed or suggested while typing.
- **Every failure answers the same "not found"**: a wrong PIN, a misspelt name, an unknown person,
  a revoked card, a code too old, a Person in the Trash.
- **Lock-outs**:
  - five failed name-and-PIN tries from one device in a minute lock name entry on that device for
    five minutes (the tablet says "Please try your code or see the desk");
  - ten wrong PINs for one Person in a day disable that Person's PIN until they set it again in the
    app (a guess spread over several devices);
  - unknown codes from one device are limited per minute.
- **A PIN** is 4 digits, set and cleared only by the member in the app, and refused when it is one
  of a short list of the most common PINs.

### What a check-in decides

Each attempt runs in order:

1. **`doorNow { code } | { name, pin }`** (Bookings, device role): identifies the Person, then
   finds what is open for them:
   - their own and their live dependants' bookings in classes whose check-in window is open (a
     dependant's only when the code is the parent's app code; a child's own card or code finds
     only the child's);
   - today's classes whose type is "walk in at the door", with their window open;
   - the window opens at the class's list opening (an hour before) and closes a set number of
     minutes after its start (decision 10: 15 by default, a Bookings setting).

   It answers the choices (given name, class name and time, booked or walk-in), each with an
   opaque choice key, and a **handle** (60 seconds, this device, used once). With nothing open it
   answers `see_desk` (or `not_found`) and logs it. A single booked class needs no choice: the
   tablet checks it in at once.
2. **`checkInHere { handle, choices[] }`** (Bookings, device role), for each choice tapped:
   - **A booking**: the move `booked` to `attended`, made as `markAttended` makes it, from a
     current read. Already attended answers `already` ("You're already checked in"). Before it, the
     tool asks `agreementsDue` for the booking's Person at the booking's point; a document due
     refuses with the reason "a document to agree to" (decision 5).
   - **A walk-in class**: `record.create` of a booking in `attended` for the Person. The host
     spends a use (allowance), holds a place (capacity) and asks agreements (entry enforcement),
     as for any booking made straight into attended.
   - Each refusal becomes a reason in the door log; the tablet shows the line in the table.

| What refused | Reason category (staff see) | The tablet says |
| --- | --- | --- |
| No membership or pass that covers this class (allowance) | Nothing to pay with | Please see the desk |
| A document due, or "agree again" (agreements, or decision 5) | A document to agree to | Please see the desk |
| The class is full (capacity) | Class full | This class is full. Please see the desk |
| The window not open yet | Too early | Check-in opens at 5:00 pm |
| The window closed | Too late | Please see your coach |
| Nothing booked and nothing to walk in to (a visitor, decision 8) | Nothing booked | Please see the desk |
| Not identified | (logged as `not_found`, no Person) | We couldn't find you. Try again or see the desk |

- **A membership past due but still giving** (decision 4) lets them in. The door log records
  "payment failing" for staff who may see memberships. The tablet says nothing; the member's app
  shows it under "Needs your attention" (stage 48's `card_failing`).
- **A child** (decision 9) checks in like anyone, with their own card, their own app code, or a
  parent's app code. Checking in records that they came; it decides nothing about who collects
  them.
- **Health**: `doorNow`, `checkInHere` and the device role never read health marks. A health note
  never blocks or delays a check-in. The coach's list keeps its mark, for staff with the
  permission, as today.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `device.enrol { name, use, role? }` | staff | an admin, a person, no grant | write (every admin told) |
| `device.setUse { deviceId, use, role? }` | staff | an admin, a person | write (audited before and after; every admin told) |
| `device.revoke { deviceId }` | staff | an admin, a person | destructive (every admin told) |
| `device.list` | staff | admins | read |
| `device.claim { enrolmentCode }` | public, desk origin only | an unenrolled browser with a valid code | write (rate-limited) |
| `device.heartbeat` | device | any enrolled device with a role | none (last seen) |
| `personCode.issueCard { personId, code, label }` | staff | `people:cards` (new: admins and members by default, grantable to a fixed-role account as `agreements:desk` is, ADR 0600 amended), a person | write (audited) |
| `personCode.revokeCard { codeId }` | staff | the same | write (audited) |
| `personCode.list { personId }` | staff | the same | read (labels and dates, never a code) |
| `me.code` | customer | the signed-in member, for themselves and their live dependants | read (opening to `customer`: reviewed) |
| `me.pin.set { pin }` / `me.pin.clear` | customer | the signed-in member | write (opening to `customer`: reviewed) |
| `x.bookings.doorNow { code } \| { name, pin }` | device | `bookings.checkin` | read (rate-limited, lock-outs) |
| `x.bookings.checkInHere { handle, choices }` | device | `bookings.checkin` | write |
| `x.bookings.doorLog { date }` | staff | `bookings:desk` (staff and granted coaches); payment reasons only with Memberships' staff read | read |

- **The device audience is new** (ADR 0402 amended). It is not `public`: every device call needs an
  enrolled, unrevoked credential on the desk origin, the `Origin` check, and the role's permission.
- Each operation open to a device is a reviewed addition to `packages/core/open-operations.json`,
  as stage 44's desk calls are.
- `identify` is not an operation: it runs only inside `doorNow`, and nothing returns a Person id to
  the page. `doorNow` answers given names only.

### The device role

```ts
deviceRoles: {
  checkin: {
    label: "Check-in tablet",
    description: "Checks members in to classes they booked and to walk-in classes. Nothing else.",
    permissions: ["bookings:checkin"],   // doorNow, checkInHere
    screen: { block: "bookings-checkin-tablet", export: "CheckInTablet" },
  },
}
```

- A device role holds no read of records. Its tools return only what their outputs declare: given
  names, class names and times, the outcome.
- The contract check refuses:
  - a device role naming another pack's tool, or a tool not declared `audiences: ["device"]`;
  - a tool open to `device` that is also open to staff, customers or the public;
  - a device role on a runtime extension (`cos ext check` and install; the key is ignored at run
    time, as `screens` is);
  - a device role with no screen, or a screen whose block is not a web block of the same pack.

### Screens

- **The tablet** (the device role's screen, web at tablet width, on the desk origin): a camera view
  for codes (a plug-in scanner that types also works), "Type your name instead", the outcome for 4
  seconds, then back. No navigation, no history, no list. Offline it shows decision 6's line
  within 5 seconds. Its own timers clear every screen; there is no session to expire, because each
  call stands alone.
- **The member** (base layer, web and native, one hook `useMyCode`): a **Check-in code** base
  section of My account (stage 48), shown when an installed pack declares a device role: the
  rotating QR, their dependants' codes under it, and Set a PIN. Native shows it at full brightness.
  It needs no new attention kind: the reasons a member is sent to the desk are already
  stage 48's `agree` and `card_failing`.
- **Staff (admin)**:
  - Settings → Devices (above).
  - Person page → Cards: issue (scan or type the card's code, with a label), revoke.
  - Bookings' **At the door** (a stage 47 screen, `opens: ["doorLog"]`): today's attempts that need
    a word, by time, given name, class and reason; links to the Person for staff who may open them,
    and to "Sign at the desk" (stage 44) when a document is due. It refreshes by polling `doorLog`.
  - The class list and front desk show "at the door" as who ticked.

### Notifications

- Every admin is told when a device is enrolled, its use or role changed, revoked, or revoked as a
  clone (stage 44's notice, generalised).
- Members are not emailed on a check-in.

### What an AI may do

- **May**: read attendance as it reads bookings today ("who came to open gym on Tuesday"), for
  staff who may read bookings.
- **May not**: enrol, change or revoke a device; issue or revoke cards; read a code or a PIN; set or
  clear a PIN; call any device tool; read the door log's payment reasons. Every one of these is
  `actors: ["human"]` or the device audience.

### Privacy and erase

- **The room**: the tablet shows a given name and the person's own choices, and nothing else. A
  dependant's given name shows only to their guardian's code.
- **No why on the screen**: reasons are categories, shown to staff only. A health note is never one.
- **Codes and PINs**: kept as HMACs or slow hashes (the app secret encrypted, because the host must
  check a rotating code). Never in a log, a URL, an error or the audit. Only the member's own app
  shows their code.
- **The door log**: kept 30 days (a setting, for the business to confirm with its lawyer or
  accountant), then purged. It is in no `rec_*` view, `query.sql`, search, export or embedding.
- **Erase** (ADR 0320): a Person's erase deletes their codes, cards, PIN, handles and door-log rows;
  their bookings' attendance follows the bookings' own erase. Merge moves cards and keeps the
  surviving Person's PIN; the other PIN is deleted.
- **The device** holds no member data. Revoked, it opens nothing.
- **The camera**: the page reads codes only and keeps no images. Whether the business should put a
  sign by the tablet is for it to confirm with its lawyer.

## Out of scope

- Check-in to appointments (stage 31b) and staff signing in to shifts or sites (time entries,
  stage 58). A device role is declared by a pack, so those packs add their own later.
- A device holding more than one use (check-in and signing on one tablet).
- NFC cards, phone taps, face or fingerprint recognition.
- A turnstile or door lock opened by a check-in (it would need a gatekeeper to a door controller).
- Queuing check-ins on the tablet while offline (issue #118).
- Selling anything on the check-in tablet, or making a Person on it.
- Counting who is in the building now (there is no check-out).
- What a till device does beyond being enrolled (stage 50).

## Acceptance criteria

1. An admin enrols a tablet on the desk origin for the `bookings.checkin` role. Every admin is
   told. A member, a coach or the AI cannot enrol, change a use or revoke (refused, audited).
2. One Settings → Devices lists devices of every use. A signing device cannot call a check-in tool,
   and a check-in device cannot claim a signing session (tests both ways).
3. The credential rotates at least daily; a retry within 60 seconds gets the same new credential;
   a credential rotated away and presented after 60 seconds revokes the device and tells every
   admin. A device unused for 30 days is refused.
4. A member booked into a class, scanning their app's code 30 minutes before it, is checked in. The
   booking is `attended`, `markedByName` is the device's name, and the coach's list shows it ticked
   "at the door".
5. The same code scanned again answers "already checked in". Two tablets checking in one booking
   at once make one check-in.
6. An app code older than 60 seconds is "not found". A card works until revoked, then is "not
   found". A handle is refused after 60 seconds, a second use, or from another device.
7. Name and PIN: an exact match checks in. A wrong PIN, a misspelt name and an unknown person all
   answer the same "not found". Five wrong tries in a minute lock name entry on that device for
   five minutes; ten wrong PINs for one Person in a day disable that PIN. Nothing typed is logged.
8. Open gym: a member whose membership covers it walks in, and a booking is made `attended` with a
   use spent. A member with nothing that covers it, a visitor, or a member with a document due sees
   "Please see the desk"; no booking is made, and the door log has the reason.
9. A booked member with a document now due is not checked in at the tablet (decision 5), and the
   coach can still tick them.
10. A member past due within the grace period is checked in, the tablet says nothing of it, and
    "payment failing" shows on At the door only to staff who may read memberships.
11. No device operation's output contains a reason category, a payment state, a health mark, a
    family name, an email address, a Person id or another member's name (a test reads every device
    operation's output schema).
12. A health note on a member changes nothing at the tablet; the device's calls make no read of
    health marks (a statement test).
13. A parent's code shows their own and their live dependants' open bookings by given name, and
    checks in the ones tapped. A child's own card shows only the child's. An ended family link shows
    nothing of that child.
14. A device call without an enrolled credential, from another origin, or with a staff session is
    refused. A revoked device is refused at its next call. A device credential cannot call any
    operation outside its role (registry-wide test).
15. A device role on a runtime extension is refused by `cos ext check` and at install.
16. The AI, MCP and automations cannot call any device operation, issue a card, read a code or set
    a PIN.
17. Erase removes the Person's codes, cards, PIN, handles and door-log rows. The door log is purged
    after its retention.
18. Offline: with the network cut, the tablet shows the offline line within 5 seconds and stores
    nothing. Back online it works with no action.
19. The coach can undo a door check-in as any tick. The no-show sweep treats a class with a door
    check-in as a taken list.
20. E2E, one per journey: a member checks in by app code to a booked class; a member walks into
    open gym; a member with nothing to pay with is sent to the desk and staff see why; an admin
    enrols and revokes a tablet.
21. Cost: a check-in reads a bounded number of rows (a statement-count test).

## Dependencies

- **Built**: stage 31a (Bookings, attendance, the coach's list, the family link), stage 32
  (memberships, passes, allowance), stage 44 steps 1 to 5 and 8 (documents, enforcement, erase),
  stage 23 (the HTTP surface, the app's device sessions), stage 24 (client apps, the native app).
- **Not built**:
  - **Stage 44 step 6** (desk signing and the desk origin): shares step 1 here (above).
  - **Stage 47** (pack screens; PR #303 is building it) for "At the door", and its build pattern
    for the device screen.
  - **Stage 48** (My account; spec on PR #311) for the Check-in code section. Until it is built, the
    section's block can be mounted on the template's account screen.
  - **Stage 46** (hosted clients): the desk hostname must exist on a hosted deployment too.
- **Uses this stage**: stage 50 (the Till) takes the enrolled device; stage 44 step 6 takes it.
- **Later, related**: issue #118 (offline queue), stage 31b (appointments), stage 58 (time
  entries), stage 14a (roles and teams).

## Migrations and numbers

Block **BM**: migrations 1130–1149, ADRs 0780–0789.

- **Migrations**: `core_device` (unless stage 44 step 6 has already made it in its own block, in
  which case a migration here adds the `role` and `till` uses and the daily-rotation columns);
  `core_person_code`, `core_person_pin`; `core_device_handle`, `core_device_event`. No `x_*` table
  is touched (the class type's new field is a pack field).
- **Permissions**: `people:cards` (core, grantable to a fixed-role account), `bookings:checkin`
  (held only by the device role).
- **ADRs the build writes**:
  1. **0780** The enrolled device: one device record, enrolment and revocation for signing, a device
     role and a till; one use per device; daily rotation with a 60-second grace (amends stage 44's
     desk ADR if step 6 writes it first).
  2. **0781** A device as a caller: the `device` audience and device roles (amends ADRs 0402 and
     0436).
  3. **0783** (written by step 3; first planned as 0782) A person's code: the rotating app code,
     cards and the PIN; identification only inside a device tool, one answer for every failure,
     the lock-outs.
  4. **A number the coordinator gives step 4** (first planned as 0783, which step 3 took)
     Checking in at the door: Bookings' check-in tools, the door's own policy on a document due
     (decision 5, beside ADR 0644), and the door log.
  5. **0784** A device's screen, served on the desk origin only (extends stage 47's screens).
- **Amended with dated notes**: ADR 0600 (`people:cards` grantable to a fixed-role account), ADR
  0553 (a tick may be a device's), stage 44's spec (the device section, when step 6 is built).

## Suggested build order

| Step | What | Files and areas | Beside what | Collides with |
| --- | --- | --- | --- | --- |
| 1 | **The enrolled device**: `core_device`, `device.enrol`, `claim`, `setUse`, `revoke`, `list`, `heartbeat`, rotation and clones, lapsing, every admin told, the desk origin's `/enrol`, Settings → Devices | `packages/db` migration, `packages/core/src/devices/` (new), `apps/app/src/server/identity.ts` and the Worker's routing (the desk origin), `packages/release` and `cos deploy` (the hostname), `open-operations.json`, the admin settings routes | Step 3; any pack work | **Stage 44 step 6** (the same table, origin and Settings page: one session builds both, or step 6 first with `core_device` general from the start); other work on public paths in `identity.ts` |
| 2 | **A device as a caller and device roles**: `StartedBy`, `TOOL_AUDIENCES`, the pipeline's device check, `deviceRoles` in the manifest and its contract checks | `packages/sdk` (`manifest.ts`, `contract.ts`), `packages/core/src/pipeline.ts`, `pack-roles.ts`, `invoke.ts`, `open-operations.json` | Step 3 | **`pack-roles.ts`** (stage 47 step 1 edits `packRoleReaches`; stage 14a); anything changing the pipeline or the audiences |
| 3 | **The person's code**: `core_person_code`, `core_person_pin`, `me.code`, `me.pin.*`, cards and `people:cards`, identification with lock-outs; erase and merge | `packages/db` migration, `packages/core/src/people-codes/` (new), `principals.ts` (the grantable list), `records/erase.ts`, `person.merge` | Steps 1 and 2 | The erase path (`person.erase`, `records/erase.ts`: the "erase completeness" area in `parallel-work.md`); `principals.ts` (other grantable-permission work) |
| 4 | **Bookings**: the `bookings.checkin` role, `doorNow`, `checkInHere`, `doorLog`, "walk in at the door", the closing setting, the door log table and its purge | `packs/bookings/index.ts`, `tools.ts`, `packages/core/src/devices/log.ts`, `retention.ts` | Step 5 | Other Bookings work in `packs/bookings/tools.ts`; stage 45's Bookings additions |
| 5 | **The member's Check-in code and Set a PIN** (web and native blocks, one hook) | base-layer blocks, `packages/client*` hooks, the template's account screen or stage 48's sections | Steps 1, 2 and 4, once step 3's operations are typed | Stage 48's account shell and its generated sections file |
| 6 | **The tablet's screen** on the desk origin, "At the door", "at the door" on the class list, e2e, the site and `SITE.md` | `apps/app` (the desk route and its bundle), stage 47's screen registry, `packs/bookings/blocks/*`, `apps/app/e2e`, `apps/marketing` | — | **Stage 47 steps 2 and 3** (the registry and routes); stage 44 step 6's desk route |

**Large.** The platform half is most of it. Steps 1 (best with stage 44 step 6), 2 and 3 can run as
three sessions at once; step 5 starts once step 3's operations are declared; steps 4 and 6 follow.

## Decided by this spec, open to override

- **The enrolled device is defined here once** and used by desk signing, the check-in tablet and
  the till. Stage 44's enrolment design is kept as it is, generalised.
- **One use per device**: signing, a device role, or a till. An admin changes it.
- **A till device's credential adds no authority**; staff sign in as themselves (the rest is
  stage 50's).
- **Every device rotates its credential at least daily**, with stage 44's 60-second grace and clone
  rule; signing devices also rotate on every claim.
- **Desk signing's calls stay on the public audience** as stage 44 designed them; only device-role
  tools use the new `device` audience. Nothing in stage 44 step 6 waits for step 2 here.
- **The device never holds a Person id**; the host answers a 60-second, single-use handle bound to
  the device.
- **The app code** is made on the phone from a secret tied to the member's app sign-in, changes
  every 30 seconds, and is accepted for 60. The web shows a code the host makes and holds no
  secret.
- **The PIN**: 4 digits, the member's own, the most common ones refused, disabled after ten wrong
  tries in a day.
- **Decision 5 is the door's own policy**, asked in `checkInHere`; it is not enforcement on the
  tick, so the coach can still let a member in.
- **A child's own card or code finds only the child's bookings**; a parent's app code finds the
  family's.
- **Walking in is per class type** ("walk in at the door"); open gym is a class type with it set,
  run as a long class from a series.
- **The tablet never makes a Person** and offers a visitor nothing but the desk.
- **The door log is kept 30 days.**
- **The member's code is a base section of My account**, with no new attention kind.

## Questions for the owner

None. Every point was decided as best practice (decisions 1 to 10 and the list above); the owner
may override any of them.

## Risks

- **Security**:
  - A device-role credential is standing authority on a shared, unattended device. Mitigations: its
    reach is two tools on its own origin, it never names a Person, enrolment is an admin's act
    announced to every admin, daily rotation and clone detection.
  - Name and PIN is the weakest path: lock-outs per device and per Person, and the same answer for
    every miss.
  - A rotating code means the host keeps the app secret recoverable (encrypted), not just hashed; a
    host breach exposes secrets that only check people in.
- **Money**: a walk-in check-in spends a use. A shared card spends someone else's; staff give it
  back (`returnUse`). Nothing charges a card.
- **Needs a real device**: a camera reading a QR off a phone screen in gym lighting; a plug-in
  scanner; the tablet's browser keeping the desk origin's cookie for weeks; the tablet's own
  pinned-browser mode (the design does not rely on it).
- **Needs a real client** (decision 1): how members arrive today, whether cards exist, and how busy
  the door is at peak (whether 4 seconds per member is fast enough).

## Status

One bullet per build step, written by that step (CONTRIBUTING.md, Working in parallel).

- **Step 3, the person's code and PIN** (branch `feat/stage-51-person-code`; migration 1135, ADR
  [0783](../adr/0783-a-persons-code-the-rotating-app-code-cards-and-the-pin.md), ADR 0600 amended).
  Built:
  - `core_person_code` (app codes tied to one sign-in, cards by HMAC), `core_person_pin` and
    `core_identify_lockout`;
  - `me.code`, `me.pin.set` and `me.pin.clear` (customer, `hostInternal`, in
    `open-operations.json`);
  - `personCode.issueCard`, `revokeCard` and `list` with the new core permission `people:cards`
    (admins and members, grantable, to a fixed-role account too: `FIXED_ROLE_CORE_GRANTS`);
  - `identifyPerson` (`packages/core/src/people-codes/identify.ts`): host code with the lock-outs
    and one answer for every miss; erase and merge.
  - Keys come from `BETTER_AUTH_SECRET` (HKDF), passed as `ctx.personCodes`.
  - After review: every try is counted before it is checked (parallel tries get no further than
    one by one), a name and PIN always costs five slow hashes, issuing a card is never queued for
    review, and two first `me.code` calls at once keep one code.
  - Deviations, in the ADR: it is ADR 0783 (the spec said 0782; the coordinator gave this step
    0783 and 0784, and the numbering list above now says so); `me.code` is risk `write` (it makes the code on a sign-in's first call); a name is
    compared by the indexed name key of the Person's listed name.
  - Left: the host path from step 4's `doorNow` to `identifyPerson` (steps 2 and 4); the door
    log's and handles' erase (step 4); Cards on the Person page (step 6); the member's blocks
    (step 5).
