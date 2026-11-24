-- Migration 1410: the host's copy of a business's booking system (stage 65 step 3, ADR 0922).
--
-- A business that keeps its booking system loads lists exported from it (a `members` list: people
-- and their memberships and passes; a `timetable` list: classes, their bookings and their coaches),
-- and the host keeps the least of them the first wave uses. Every row here is a copy of what the
-- booking system said in the list it came from: nothing in it is the business's own record, each
-- load of a kind replaces the copy of that kind, and nothing is ever written back.
--
-- New tables only, all core: in no rec_* view, so no query.sql, export, search, dashboard or AI
-- record read reaches them; they are read only through the `outside.*` operations. No x_* table and
-- no core_write_guard kind. No foreign key to core_person or core_user: an erased or merged Person's
-- outside rows are removed by erase and merge themselves (stage 65 step 10), and a link to a Person
-- who is gone or in the Trash counts as no link (every count and load joins the live Persons).
--
-- An outside person is matched to a Person by address, never merged: a link by address changes
-- nothing on the Person. `link_how` says how: `address` (the host found exactly one Person with
-- the address) or `staff` (a person with bookingSystem:manage chose, with why). A staff link with
-- no Person is staff saying "nobody here"; that decision itself is kept by hash in
-- core_outside_unlinked, so it outlives the row and keeps no name or address.

-- The one row of settings (a human admin's, outside.settings.update): the source, on or off, the
-- outside types that make a Person a member (NULL: every type of kind `membership`, no pass), the
-- business's two links (each https, shown as is), the largest age a members list counts for, and
-- the saved column mappings and value maps per kind (stage 65 step 4).
CREATE TABLE core_outside_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('file')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  member_types TEXT CHECK (
    member_types IS NULL OR (json_valid(member_types) AND json_type(member_types) = 'array')
  ),
  manage_url TEXT CHECK (
    manage_url IS NULL OR (substr(manage_url, 1, 8) = 'https://' AND length(manage_url) <= 500)
  ),
  book_url TEXT CHECK (
    book_url IS NULL OR (substr(book_url, 1, 8) = 'https://' AND length(book_url) <= 500)
  ),
  largest_age_days INTEGER NOT NULL DEFAULT 31 CHECK (largest_age_days BETWEEN 1 AND 90),
  mappings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mappings)),
  updated_by TEXT,
  updated_at TEXT
);
INSERT INTO core_outside_settings (id) VALUES (1);

-- Each loaded list: its kind, the date its file was exported (what its age is counted from), who
-- loaded it and when, and counts only (rows read, refused, kept): never a name or an address. One
-- `current` list per kind is the copy; a replaced or removed one stays 30 days as a log.
CREATE TABLE core_outside_list (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('members', 'timetable')),
  source TEXT NOT NULL CHECK (source IN ('file')),
  exported_on TEXT NOT NULL CHECK (exported_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  loaded_by TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  refused_count INTEGER NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
  kept_count INTEGER NOT NULL DEFAULT 0 CHECK (kept_count >= 0),
  -- The column mapping used (headers only), for the log.
  mapping TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping)),
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'replaced', 'removed')),
  ended_at TEXT,
  CHECK ((state = 'current') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX core_outside_list_current ON core_outside_list (kind) WHERE state = 'current';
CREATE INDEX core_outside_list_ended ON core_outside_list (ended_at) WHERE ended_at IS NOT NULL;

-- An outside person kept from the current members list: only while they are a member, hold a live
-- pass, are booked in the current timetable, or are staff-linked (`why_kept`). The address as the
-- host normalises it, and its folded form (ADR 0692) the matching reads. Never a phone, a postal
-- address, a birth date, a card or a note.
CREATE TABLE core_outside_person (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  address TEXT CHECK (address IS NULL OR (address = lower(trim(address)) AND address <> '')),
  address_folded TEXT CHECK ((address IS NULL) = (address_folded IS NULL)),
  given_name TEXT CHECK (given_name IS NULL OR length(given_name) <= 500),
  family_name TEXT CHECK (family_name IS NULL OR length(family_name) <= 500),
  member_status TEXT NOT NULL CHECK (
    member_status IN ('member', 'not_member', 'suspended', 'expired', 'ended', 'declined')
  ),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  why_kept TEXT NOT NULL CHECK (why_kept IN ('member', 'pass', 'booked', 'staff')),
  person_id TEXT,
  link_how TEXT CHECK (link_how IS NULL OR link_how IN ('address', 'staff')),
  -- A staff link's who and why (a person with bookingSystem:manage).
  link_by TEXT,
  link_why TEXT CHECK (link_why IS NULL OR length(link_why) <= 500),
  linked_at TEXT,
  CHECK ((link_how IS NULL) = (linked_at IS NULL)),
  CHECK (link_how IS NOT NULL OR person_id IS NULL),
  CHECK (link_how IS NOT 'address' OR person_id IS NOT NULL),
  CHECK ((link_how IS 'staff') = (link_by IS NOT NULL))
);
CREATE INDEX core_outside_person_address ON core_outside_person (address_folded)
  WHERE address_folded IS NOT NULL;
CREATE INDEX core_outside_person_person ON core_outside_person (person_id)
  WHERE person_id IS NOT NULL;

-- What the business sells that grants membership (`membership`) or uses (`pass`), as listed.
CREATE TABLE core_outside_membership_type (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (kind IN ('membership', 'pass')),
  active INTEGER NOT NULL CHECK (active IN (0, 1))
);

-- A membership or pass a kept outside person holds, as listed.
CREATE TABLE core_outside_membership (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 1200),
  list_id TEXT NOT NULL,
  person_ref TEXT NOT NULL,
  type_ref TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (kind IN ('membership', 'pass')),
  status TEXT NOT NULL CHECK (status IN ('live', 'paused', 'ended', 'cancelled')),
  from_date TEXT CHECK (from_date IS NULL OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  until_date TEXT CHECK (until_date IS NULL OR until_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  uses_total INTEGER CHECK (uses_total IS NULL OR uses_total >= 0),
  uses_left INTEGER CHECK (uses_left IS NULL OR uses_left >= 0),
  renews INTEGER NOT NULL CHECK (renews IN (0, 1))
);
CREATE INDEX core_outside_membership_person ON core_outside_membership (person_ref);

-- The timetable list's class types, classes, bookings and coaches.
CREATE TABLE core_outside_class_type (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  active INTEGER NOT NULL CHECK (active IN (0, 1))
);

CREATE TABLE core_outside_class (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  class_type_ref TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location_name TEXT CHECK (location_name IS NULL OR length(location_name) <= 500),
  staff_ref TEXT,
  places INTEGER CHECK (places IS NULL OR places >= 0),
  booked INTEGER NOT NULL CHECK (booked >= 0),
  waiting INTEGER NOT NULL CHECK (waiting >= 0),
  cancelled INTEGER NOT NULL CHECK (cancelled IN (0, 1)),
  CHECK (ends_at > starts_at)
);
CREATE INDEX core_outside_class_starts ON core_outside_class (starts_at);
CREATE INDEX core_outside_class_staff ON core_outside_class (staff_ref) WHERE staff_ref IS NOT NULL;

CREATE TABLE core_outside_booking (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  class_ref TEXT NOT NULL,
  person_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('booked', 'waiting', 'attended', 'late_cancelled', 'no_show', 'cancelled')
  )
);
CREATE INDEX core_outside_booking_class ON core_outside_booking (class_ref);
CREATE INDEX core_outside_booking_person ON core_outside_booking (person_ref);

-- A coach as the booking system names them, matched to a staff account by address the same way.
CREATE TABLE core_outside_staff (
  ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 600),
  list_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 500),
  address TEXT CHECK (address IS NULL OR (address = lower(trim(address)) AND address <> '')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  user_id TEXT,
  link_how TEXT CHECK (link_how IS NULL OR link_how IN ('address', 'staff')),
  link_by TEXT,
  link_why TEXT CHECK (link_why IS NULL OR length(link_why) <= 500),
  linked_at TEXT,
  CHECK ((link_how IS NULL) = (linked_at IS NULL)),
  CHECK (link_how IS NOT NULL OR user_id IS NULL),
  CHECK (link_how IS NOT 'address' OR user_id IS NOT NULL),
  CHECK ((link_how IS 'staff') = (link_by IS NOT NULL))
);
CREATE INDEX core_outside_staff_user ON core_outside_staff (user_id) WHERE user_id IS NOT NULL;

-- An outside person or coach waiting for a person to link them: the candidates (Persons, or staff
-- accounts) and why nobody was linked. Kept while the outside row is; replaced at each load.
CREATE TABLE core_outside_match (
  kind TEXT NOT NULL CHECK (kind IN ('person', 'staff')),
  ref TEXT NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('several_people', 'shared_address', 'no_address')),
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(candidates) AND json_type(candidates) = 'array'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- An erased Person's outside ref and address, by hash only (as core_erased_address): the next
-- load keeps nothing of them. Written by erase (stage 65 step 10); read at every load.
CREATE TABLE core_outside_suppressed (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ref', 'address')),
  created_at TEXT NOT NULL
);

-- Staff's "nobody here" for an outside person or coach (outside.unlink), by the hash of the ref
-- only: the next load links that ref by address never again, until a person links it by hand, and
-- keeps no row for it unless it is kept for another reason (a member, a live pass, booked).
CREATE TABLE core_outside_unlinked (
  kind TEXT NOT NULL CHECK (kind IN ('person', 'staff')),
  hash TEXT NOT NULL,
  unlinked_by TEXT NOT NULL,
  unlinked_at TEXT NOT NULL,
  PRIMARY KEY (kind, hash)
);
