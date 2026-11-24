# ADR 0783: A person's code: the rotating app code, cards and the PIN

Status: accepted, 2026-11-24 (stage 51, build step 3: the person's code and PIN). Amends
[ADR 0600](0600-a-pack-role-and-its-grants-add-up.md) (a fixed-role account may be granted
`people:cards`). Builds on [ADR 0402](0402-staff-and-customers.md) (audiences),
[ADR 0419](0419-native-sessions-and-customer-sign-in.md) (the app's device sessions),
[ADR 0540](0540-the-family-link.md) (the family link) and
[ADR 0320](0320-erase-reaches-every-store.md) (erase). The spec,
[`docs/stages/51-kiosk-check-in.md`](../stages/51-kiosk-check-in.md), numbered this ADR 0782; block
BM gave this step 0783 and 0784, so it is 0783. The enrolled device (step 1), the device as a caller
(step 2) and Bookings' check-in tools (step 4) are other ADRs.

## Context
A member checks in at the door's tablet by the code in their app, a card the gym gives them, or
their full name and a PIN (stage 51, decision 2). Nothing identified a Person by a code before:
grants have codes (tickets), people did not. Whatever identifies a Person must stay in the host:
the tablet is unattended and shared, so it must never hold a Person id, list anyone, or learn why
a try failed.

## Decision
- **Three tables** (migration 1135), in no `rec_*` view, search, export or embedding:
  - `core_person_code` (`pc_…`): an **app code** or a **card**.
  - `core_person_pin`: at most one PIN per Person.
  - `core_identify_lockout`: failed tries per device and entry this minute. No Person, nothing
    typed. The device id is text with no foreign key until step 1's `core_device`.
- **The app code rotates.** It is RFC 6238 (TOTP: HMAC-SHA1, 30 seconds, 8 digits), so the native
  app makes it offline with any TOTP implementation. The QR carries `<code id>.<8 digits>`. The
  host accepts this step and the one before, so a screenshot works for at most 60 seconds.
  - **One code per sign-in.** Each is tied by a foreign key to the sign-in that asked for it (a
    native app's `core_device_session`, or a browser's `core_customer_session`). Signing out,
    revoking the session or deleting the account deletes it, and an expired or idle sign-in
    identifies no one.
  - **`me.code`** (customer, `hostInternal`) answers the caller's code and one for each live
    dependant (by given name, never a family name), making them the first time.
    - A native app's sign-in is also given the secret (base32) to make the code offline.
    - A browser's is given only the current value and asks again at `refreshAt`; it holds no
      secret.
    - It is risk `write` (the spec said read), because the first call on a sign-in makes the
      code. Later calls write nothing but the audit row, which records only how many codes were
      shown.
  - **A dependant's code** shown on a guardian's app identifies the dependant only while that link
    is live, and is checked again at every try. The Person's own app code is the only way in that
    may show their dependants' bookings (`family: true`). A card, a PIN and a dependant's code
    show only that Person's.
- **Cards** are a fixed long code (at least 8 characters, normalised as Ticketing's codes:
  upper case, no spaces or hyphens).
  - Only their HMAC is kept: the code is never stored, shown, listed or audited.
  - One live card per code. Revoked, a card identifies no one, and its code may go on a new card.
  - `personCode.issueCard`, `revokeCard` and `list` need the new core permission **`people:cards`**.
    Admins and members hold it by default. It is grantable, to a fixed-role account too (the ADR
    0600 amendment). The three operations are `actors: ["human"]` and not on MCP.
- **The PIN** is 4 digits, set and cleared only by the member (`me.pin.set`, `me.pin.clear`).
  - The most common ones are refused (repeated digits, runs, the usual favourites).
  - It is kept as PBKDF2-SHA256 (100,000 iterations, the Workers maximum) over the PIN keyed by an
    HMAC, with its own salt. A copy of the database alone cannot be searched for 4-digit PINs.
- **The keys** come from the host's auth secret (`BETTER_AUTH_SECRET`) by HKDF: one key for card
  HMACs, one (AES-GCM) to seal app secrets, one for the PIN. The adapter passes them as
  `ctx.personCodes`; on a customer's call only a `hostInternal` core operation gets them.
  - The host must check a rotating code, so app secrets are encrypted, not hashed. A host breach
    exposes secrets that only check people in.
  - Changing the auth secret ends every card, app code and PIN. Cards are issued again, codes are
    made again at the next `me.code`, and members set their PIN again.
  - A secret of its own was not added: it would need every deploy path to make and keep it.
- **Identification is host code, not an operation** (`identifyPerson`, `people-codes/identify.ts`).
  A device tool (step 4's `doorNow`) calls it with the device's id from its verified credential.
  - It answers a Person id to host code only, with how they were identified and whether the
    family may be shown.
  - A name is compared case-folded, accents folded and spaces normalised against the Person's
    name as their record lists it: the duplicate rules' indexed `name_key` (ADR 0247), which is
    their given and family names unless staff gave them another display name. Middle initials
    are ignored, as there.
    - At most five People with a PIN are checked for one name.
    - Exactly one Person must match both the name and the PIN. Two People of the same name with
      the same PIN find no one.
  - **Every miss answers the same `not_found`**: a wrong PIN, a misspelt name, an unknown person,
    a revoked card, a code too old, a sign-in ended, a link ended, a Person in the Trash.
  - **Lock-outs**:
    - five failed name-and-PIN tries from one device in a minute lock name entry there for five
      minutes;
    - twenty unknown codes from one device in a minute lock code entry for a minute;
    - ten wrong PINs for one Person in a day (from any devices) disable the PIN until the member
      sets it again.
    - A locked entry answers `locked` and checks nothing.
    - The counters are written at once, outside the calling tool's batch: a failed try counts
      even if the tool then fails, and the tool is a read.
  - **Cost**: each try runs at most six statements, each with a handful of bound values. A name
    runs at most five PBKDF2 checks.
- **Erase and merge.**
  - Erase deletes the Person's codes, cards and PIN, and the dependants' codes on their app, in
    the erase's batch (`people-codes/people.ts`; the foreign keys would too).
  - Merge moves cards to the survivor and keeps the survivor's PIN, deleting the merged one's.
  - App codes are deleted rather than moved, and `me.code` makes them again for whoever the
    sign-in now belongs to. Moving them could join two codes on one sign-in for one Person.

## Consequences
- Step 4's `doorNow` must reach `identifyPerson` from host code. It is not an operation and returns
  a Person id, so a pack's sandboxed tool cannot call it directly. Step 2 (a device as a caller)
  or step 4 adds the host path, and that path keeps the Person id out of the device's output.
- Step 1's `core_device` should delete a revoked device's `core_identify_lockout` rows, or leave
  them to expire: they hold no Person.
- Step 5's blocks (`useMyCode`) call `me.code`, `me.pin.set` and `me.pin.clear`. The native app
  keeps the secret in the phone's secure storage and makes the code by TOTP.
- Step 4 deletes a Person's door-log rows and handles on erase. This step deletes only codes,
  cards and PINs.
- A Person whose display name is not their given and family names (a nickname) checks in by name
  and PIN with the name their record is listed under. The spec said given and family names; the
  stored key is the indexed one, and comparing both would need a second key kept in step with
  renames.
