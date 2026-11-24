-- Migration 1030: quotes, invoices and credit notes, their lines, the numbering series and the
-- document event log (stage 35 step 2, ADRs 0730 and 0732).
--
-- Quotes, invoices and credit notes are base records in core, like Order. A draft has no number
-- and staff (and the assistant, through the gate) change it freely. Sending a quote, or issuing an
-- invoice or a credit note, gives it the next number of its series in that batch; from then on the
-- database refuses any change to what it says: the bill-to, the lines, the totals, the tax, the
-- number, the dates it was given and the snapshot of the business. Only its state and the host's
-- bookkeeping fields (reminders, part payments allowed, the due date) move afterwards, and only by
-- host code. A draft is deleted freely; an issued document is never deleted (the retention purge,
-- stage 35 step 11, is the one way, and amends the triggers below when it is built).
--
-- Every amount is an integer in the currency's minor unit. Tax is worked out by the host from the
-- business's own rates (ADR 0732): each line's tax rounded half up, the document's tax the sum of
-- its lines. A quantity is held in thousandths (hours and metres), so no amount is a float.
--
-- D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE deletes fire no delete
-- trigger: every table here refuses an insert whose key already exists (a REPLACE is an insert),
-- so a REPLACE cannot get round the triggers that refuse an update or a delete (as migration 0850).
--
-- The bill-to's ids are Person and Organisation ids that an erase sets to null (ON DELETE SET
-- NULL): the only change to an issued document's bill-to the triggers let through. What was
-- printed (bill_to_*) stays.

-- One numbering series each for quotes, invoices and credit notes. A human admin sets the prefix
-- and the next number (invoice.settings.update), which only goes up. Every change moves `version`
-- by exactly one: an admin's change names the version it read, so one made against a series that
-- issued a number meanwhile is refused (compare-and-set); the issuing batch bumps it in SQL.
CREATE TABLE core_document_counter (
  series TEXT PRIMARY KEY CHECK (series IN ('quote', 'invoice', 'credit_note')),
  prefix TEXT NOT NULL CHECK (length(prefix) <= 12),
  next_number INTEGER NOT NULL CHECK (next_number BETWEEN 1 AND 99999999),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO core_document_counter (series, prefix, next_number) VALUES
  ('quote', 'Q-', 1), ('invoice', 'INV-', 1), ('credit_note', 'CN-', 1);

CREATE TRIGGER core_document_counter_forward
BEFORE UPDATE ON core_document_counter
WHEN NEW.series IS NOT OLD.series OR NEW.next_number < OLD.next_number
  OR NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_document_counter_back');
END;

-- Its three rows are the ones above: no other insert (a REPLACE included, which would reset one).
CREATE TRIGGER core_document_counter_no_insert
BEFORE INSERT ON core_document_counter
BEGIN
  SELECT RAISE(ABORT, 'core_document_counter_back');
END;

CREATE TRIGGER core_document_counter_no_delete
BEFORE DELETE ON core_document_counter
BEGIN
  SELECT RAISE(ABORT, 'core_document_counter_back');
END;

-- A quote: an offer at stated prices, valid until a date. `sent` is its issued state: it has its
-- number from then on and says what it said. accepted, declined, expired and withdrawn are final.
CREATE TABLE core_quote (
  -- qt_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  -- The series' prefix and number at send (Q-0041), and the number alone.
  number TEXT,
  number_seq INTEGER,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- Whether the lines' unit prices were typed without tax (added on top) or with it (inside).
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('exclusive', 'inclusive')),
  -- Whom it is addressed to: a Person, or an Organisation and its contact Person (person_id).
  person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  organisation_id TEXT REFERENCES core_organisation (id) ON DELETE SET NULL,
  -- The bill-to as printed, fixed at send (null on a draft).
  bill_to_name TEXT,
  bill_to_address TEXT,
  bill_to_tax_number TEXT,
  bill_to_email TEXT,
  site_address TEXT,
  -- Any record the quote is about (a deal, a booking, later a job): its object and id.
  about_object TEXT,
  about_id TEXT,
  title TEXT,
  notes TEXT,
  valid_until TEXT,
  deposit_kind TEXT NOT NULL DEFAULT 'none' CHECK (deposit_kind IN ('none', 'amount', 'percent')),
  -- An amount in minor units, or a percentage in hundredths of a percent (2500 = 25%).
  deposit_value INTEGER,
  net_total INTEGER NOT NULL DEFAULT 0 CHECK (net_total >= 0),
  tax_total INTEGER NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- The totals by rate, as JSON [{key, label, rate, net, tax, total}].
  tax_by_rate TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tax_by_rate)),
  replaces_quote_id TEXT REFERENCES core_quote (id),
  acceptance_id TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  withdrawn_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  -- Counts the quote's writes: a write made from an older read is refused (compare-and-set).
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (total = net_total + tax_total),
  CHECK (deposit_kind = 'none' OR deposit_value > 0),
  CHECK (deposit_kind != 'percent' OR deposit_value <= 10000),
  CHECK ((about_object IS NULL) = (about_id IS NULL))
);
CREATE UNIQUE INDEX core_quote_number_uq ON core_quote (number_seq) WHERE number_seq IS NOT NULL;
CREATE INDEX core_quote_person_idx ON core_quote (person_id, created_at);
CREATE INDEX core_quote_organisation_idx ON core_quote (organisation_id, created_at)
  WHERE organisation_id IS NOT NULL;
CREATE INDEX core_quote_state_idx ON core_quote (state, created_at);

-- An invoice: a numbered request for payment, with its own order from issue (stage 35 step 3).
CREATE TABLE core_invoice (
  -- inv_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'issued', 'sent', 'part_paid', 'paid', 'credited', 'void')),
  kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'deposit', 'final')),
  number TEXT,
  number_seq INTEGER,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('exclusive', 'inclusive')),
  person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  organisation_id TEXT REFERENCES core_organisation (id) ON DELETE SET NULL,
  bill_to_name TEXT,
  bill_to_address TEXT,
  bill_to_tax_number TEXT,
  bill_to_email TEXT,
  site_address TEXT,
  about_object TEXT,
  about_id TEXT,
  title TEXT,
  notes TEXT,
  -- The quote it was made from (a deposit, a progress claim, the final invoice).
  quote_id TEXT REFERENCES core_quote (id),
  -- The order issuing started (stage 35 step 3).
  order_id TEXT,
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 365),
  issued_on TEXT,
  -- Set by staff on a draft, or worked out at issue from the terms; host code may move it later
  -- (invoice.setDueDate), so it is not fixed by the trigger below.
  due_on TEXT,
  issued_at TEXT,
  sent_at TEXT,
  allow_part_payments INTEGER NOT NULL DEFAULT 0 CHECK (allow_part_payments IN (0, 1)),
  reminders_paused INTEGER NOT NULL DEFAULT 0 CHECK (reminders_paused IN (0, 1)),
  reminders_paused_reason TEXT,
  net_total INTEGER NOT NULL DEFAULT 0 CHECK (net_total >= 0),
  tax_total INTEGER NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  tax_by_rate TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tax_by_rate)),
  -- The business's details, bank details and footer as at issue (JSON; null on a draft).
  business TEXT CHECK (business IS NULL OR json_valid(business)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (total = net_total + tax_total),
  CHECK ((about_object IS NULL) = (about_id IS NULL))
);
CREATE UNIQUE INDEX core_invoice_number_uq ON core_invoice (number_seq) WHERE number_seq IS NOT NULL;
CREATE INDEX core_invoice_person_idx ON core_invoice (person_id, created_at);
CREATE INDEX core_invoice_organisation_idx ON core_invoice (organisation_id, created_at)
  WHERE organisation_id IS NOT NULL;
CREATE INDEX core_invoice_state_idx ON core_invoice (state, created_at);
CREATE INDEX core_invoice_quote_idx ON core_invoice (quote_id) WHERE quote_id IS NOT NULL;

-- A credit note: a numbered document that reduces what an invoice asks for (stage 35 step 5).
CREATE TABLE core_credit_note (
  -- cn_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'issued')),
  number TEXT,
  number_seq INTEGER,
  invoice_id TEXT NOT NULL REFERENCES core_invoice (id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('exclusive', 'inclusive')),
  person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  organisation_id TEXT REFERENCES core_organisation (id) ON DELETE SET NULL,
  bill_to_name TEXT,
  bill_to_address TEXT,
  bill_to_tax_number TEXT,
  bill_to_email TEXT,
  reason TEXT,
  -- Reduce what is owed, give back what was paid, or both in that order.
  settle TEXT NOT NULL DEFAULT 'reduce' CHECK (settle IN ('reduce', 'refund', 'both')),
  issued_on TEXT,
  issued_at TEXT,
  net_total INTEGER NOT NULL DEFAULT 0 CHECK (net_total >= 0),
  tax_total INTEGER NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  tax_by_rate TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tax_by_rate)),
  business TEXT CHECK (business IS NULL OR json_valid(business)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (total = net_total + tax_total)
);
CREATE UNIQUE INDEX core_credit_note_number_uq ON core_credit_note (number_seq)
  WHERE number_seq IS NOT NULL;
CREATE INDEX core_credit_note_invoice_idx ON core_credit_note (invoice_id);

-- Lines, one table per document. A line comes from a record of a sellable object, priced by the
-- host when added (`record`), or is typed by staff (`custom`); a deduction ("less deposit paid",
-- invoices only) is written only by the host and names the deposit invoice it deducts. A staff
-- discount on a line lowers its net, and the tax is worked out on what is left. The rate's key,
-- its rate (hundredths of a percent: 1000 = 10%) and its label are kept on the line as used.
CREATE TABLE core_quote_line (
  -- qtl_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  quote_id TEXT NOT NULL REFERENCES core_quote (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli BETWEEN 1 AND 10000000),
  unit TEXT,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  tax_key TEXT,
  tax_label TEXT,
  tax_rate INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 10000),
  discount_kind TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('amount', 'percent')),
  discount_value INTEGER,
  discount_reason TEXT,
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_net INTEGER NOT NULL CHECK (line_net >= 0),
  line_tax INTEGER NOT NULL CHECK (line_tax >= 0),
  line_total INTEGER NOT NULL CHECK (line_total >= 0),
  source TEXT NOT NULL CHECK (source IN ('record', 'custom')),
  source_object TEXT,
  source_id TEXT,
  source_category TEXT,
  -- A record line: the record's price as the host read it (with tax, ADR 0479), per unit.
  source_price INTEGER,
  created_at TEXT NOT NULL,
  CHECK (line_total = line_net + line_tax),
  CHECK ((source = 'record') = (source_object IS NOT NULL AND source_id IS NOT NULL)),
  CHECK ((tax_key IS NULL) = (tax_rate = 0 AND tax_label IS NULL)),
  CHECK ((discount_kind IS NULL) = (discount_value IS NULL))
);
CREATE INDEX core_quote_line_quote_idx ON core_quote_line (quote_id, position);

CREATE TABLE core_invoice_line (
  -- inl_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES core_invoice (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli BETWEEN 1 AND 10000000),
  unit TEXT,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  tax_key TEXT,
  tax_label TEXT,
  tax_rate INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 10000),
  discount_kind TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('amount', 'percent')),
  discount_value INTEGER,
  discount_reason TEXT,
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_net INTEGER NOT NULL CHECK (line_net >= 0),
  line_tax INTEGER NOT NULL CHECK (line_tax >= 0),
  line_total INTEGER NOT NULL CHECK (line_total >= 0),
  source TEXT NOT NULL CHECK (source IN ('record', 'custom', 'deduction')),
  source_object TEXT,
  source_id TEXT,
  source_category TEXT,
  source_price INTEGER,
  -- A deduction line: the deposit invoice whose payment it takes off.
  deducts_invoice_id TEXT REFERENCES core_invoice (id),
  created_at TEXT NOT NULL,
  CHECK (line_total = line_net + line_tax),
  CHECK ((source = 'record') = (source_object IS NOT NULL AND source_id IS NOT NULL)),
  CHECK ((source = 'deduction') = (deducts_invoice_id IS NOT NULL)),
  CHECK ((tax_key IS NULL) = (tax_rate = 0 AND tax_label IS NULL)),
  CHECK ((discount_kind IS NULL) = (discount_value IS NULL))
);
CREATE INDEX core_invoice_line_invoice_idx ON core_invoice_line (invoice_id, position);

CREATE TABLE core_credit_note_line (
  -- cnl_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  credit_note_id TEXT NOT NULL REFERENCES core_credit_note (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli BETWEEN 1 AND 10000000),
  unit TEXT,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  tax_key TEXT,
  tax_label TEXT,
  tax_rate INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 10000),
  line_net INTEGER NOT NULL CHECK (line_net >= 0),
  line_tax INTEGER NOT NULL CHECK (line_tax >= 0),
  line_total INTEGER NOT NULL CHECK (line_total >= 0),
  -- The invoice line it credits (part of its quantity), or null for an amount at a rate.
  credits_line_id TEXT REFERENCES core_invoice_line (id),
  created_at TEXT NOT NULL,
  CHECK (line_total = line_net + line_tax),
  CHECK ((tax_key IS NULL) = (tax_rate = 0 AND tax_label IS NULL))
);
CREATE INDEX core_credit_note_line_note_idx ON core_credit_note_line (credit_note_id, position);

-- The document event log (decision 11): one row per issue, send, payment applied or reversed,
-- credit, refund confirmed, paid back and void, written by host code in the batch of the event.
-- Finance reports (stage 52) and Accounting sync (stage 61) read it by `seq`, which only grows
-- (AUTOINCREMENT never reuses one). Nothing changes or deletes a row.
CREATE TABLE core_invoice_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('quote', 'invoice', 'credit_note')),
  document_id TEXT NOT NULL,
  -- The invoice the event concerns (a credit note's invoice), null for a quote's.
  invoice_id TEXT,
  event TEXT NOT NULL CHECK (event IN ('issued', 'sent', 'payment_applied', 'payment_reversed',
    'credited', 'refund_confirmed', 'paid_back', 'voided')),
  payment_id TEXT,
  method TEXT,
  amount INTEGER,
  currency TEXT,
  at TEXT NOT NULL,
  -- The staff account that caused it, or null for the host (a verified payment, the cron).
  by_user TEXT
);
CREATE INDEX core_invoice_event_document_idx ON core_invoice_event (document_id, seq);

-- Never over an existing row (a REPLACE), and never below the newest one: a reader that has read
-- up to a seq never misses a row written after it.
CREATE TRIGGER core_invoice_event_insert
BEFORE INSERT ON core_invoice_event
WHEN EXISTS (SELECT 1 FROM core_invoice_event e WHERE e.seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'core_invoice_event_immutable');
END;

CREATE TRIGGER core_invoice_event_in_order
AFTER INSERT ON core_invoice_event
WHEN NEW.seq < (SELECT MAX(seq) FROM core_invoice_event)
BEGIN
  SELECT RAISE(ABORT, 'core_invoice_event_immutable');
END;

CREATE TRIGGER core_invoice_event_no_update
BEFORE UPDATE ON core_invoice_event
BEGIN
  SELECT RAISE(ABORT, 'core_invoice_event_immutable');
END;

CREATE TRIGGER core_invoice_event_no_delete
BEFORE DELETE ON core_invoice_event
BEGIN
  SELECT RAISE(ABORT, 'core_invoice_event_immutable');
END;

-- --- Quotes ---------------------------------------------------------------------------------

-- A new quote is a draft with no number, never over an existing id.
CREATE TRIGGER core_quote_new
BEFORE INSERT ON core_quote
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_quote q WHERE q.id = NEW.id)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' OR NEW.number IS NOT NULL OR NEW.number_seq IS NOT NULL
      OR NEW.version != 0
      THEN RAISE(ABORT, 'core_document_new')
  END;
END;

-- Every write names the version it read (compare-and-set), except an erase's ON DELETE SET NULL
-- of the bill-to's ids. Once sent, nothing it says changes; it never goes back to a draft; a
-- number is given once, the next of the series, in the batch that bumped the series.
CREATE TRIGGER core_quote_update
BEFORE UPDATE ON core_quote
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.version IS NOT OLD.version + 1
      AND NEW.person_id IS OLD.person_id AND NEW.organisation_id IS OLD.organisation_id
      THEN RAISE(ABORT, 'core_document_stale')
    WHEN OLD.state != 'draft' AND (NEW.state = 'draft'
      OR (NEW.person_id IS NOT OLD.person_id AND NEW.person_id IS NOT NULL)
      OR (NEW.organisation_id IS NOT OLD.organisation_id AND NEW.organisation_id IS NOT NULL)
      OR NEW.number IS NOT OLD.number OR NEW.number_seq IS NOT OLD.number_seq
      OR NEW.currency IS NOT OLD.currency OR NEW.tax_mode IS NOT OLD.tax_mode
      OR NEW.bill_to_name IS NOT OLD.bill_to_name OR NEW.bill_to_address IS NOT OLD.bill_to_address
      OR NEW.bill_to_tax_number IS NOT OLD.bill_to_tax_number
      OR NEW.bill_to_email IS NOT OLD.bill_to_email OR NEW.site_address IS NOT OLD.site_address
      OR NEW.about_object IS NOT OLD.about_object OR NEW.about_id IS NOT OLD.about_id
      OR NEW.title IS NOT OLD.title OR NEW.notes IS NOT OLD.notes
      OR NEW.valid_until IS NOT OLD.valid_until OR NEW.deposit_kind IS NOT OLD.deposit_kind
      OR NEW.deposit_value IS NOT OLD.deposit_value OR NEW.net_total IS NOT OLD.net_total
      OR NEW.tax_total IS NOT OLD.tax_total OR NEW.total IS NOT OLD.total
      OR NEW.tax_by_rate IS NOT OLD.tax_by_rate
      OR NEW.replaces_quote_id IS NOT OLD.replaces_quote_id OR NEW.sent_at IS NOT OLD.sent_at
      OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' AND NEW.number IS NULL
      THEN RAISE(ABORT, 'core_document_number')
    WHEN NEW.number_seq IS NOT OLD.number_seq AND (OLD.number_seq IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM core_document_counter c WHERE c.series = 'quote'
        AND NEW.number_seq = c.next_number - 1
        AND NEW.number IS c.prefix || printf('%04d', NEW.number_seq)))
      THEN RAISE(ABORT, 'core_document_number')
  END;
END;

CREATE TRIGGER core_quote_no_delete
BEFORE DELETE ON core_quote
WHEN OLD.state != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

-- A quote's lines change only while it is a draft, and never move to another quote.
CREATE TRIGGER core_quote_line_insert
BEFORE INSERT ON core_quote_line
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_quote_line l WHERE l.id = NEW.id)
      OR NOT EXISTS (SELECT 1 FROM core_quote q WHERE q.id = NEW.quote_id AND q.state = 'draft')
      THEN RAISE(ABORT, 'core_document_immutable')
  END;
END;

CREATE TRIGGER core_quote_line_update
BEFORE UPDATE ON core_quote_line
WHEN NEW.id IS NOT OLD.id OR NEW.quote_id IS NOT OLD.quote_id
  OR NOT EXISTS (SELECT 1 FROM core_quote q WHERE q.id = OLD.quote_id AND q.state = 'draft')
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

CREATE TRIGGER core_quote_line_delete
BEFORE DELETE ON core_quote_line
WHEN EXISTS (SELECT 1 FROM core_quote q WHERE q.id = OLD.quote_id AND q.state != 'draft')
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

-- --- Invoices -------------------------------------------------------------------------------

CREATE TRIGGER core_invoice_new
BEFORE INSERT ON core_invoice
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_invoice i WHERE i.id = NEW.id)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' OR NEW.number IS NOT NULL OR NEW.number_seq IS NOT NULL
      OR NEW.version != 0
      THEN RAISE(ABORT, 'core_document_new')
  END;
END;

CREATE TRIGGER core_invoice_update
BEFORE UPDATE ON core_invoice
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.version IS NOT OLD.version + 1
      AND NEW.person_id IS OLD.person_id AND NEW.organisation_id IS OLD.organisation_id
      THEN RAISE(ABORT, 'core_document_stale')
    WHEN OLD.state != 'draft' AND (NEW.state = 'draft'
      OR (NEW.person_id IS NOT OLD.person_id AND NEW.person_id IS NOT NULL)
      OR (NEW.organisation_id IS NOT OLD.organisation_id AND NEW.organisation_id IS NOT NULL)
      OR NEW.number IS NOT OLD.number OR NEW.number_seq IS NOT OLD.number_seq
      OR NEW.kind IS NOT OLD.kind
      OR NEW.currency IS NOT OLD.currency OR NEW.tax_mode IS NOT OLD.tax_mode
      OR NEW.bill_to_name IS NOT OLD.bill_to_name OR NEW.bill_to_address IS NOT OLD.bill_to_address
      OR NEW.bill_to_tax_number IS NOT OLD.bill_to_tax_number
      OR NEW.bill_to_email IS NOT OLD.bill_to_email OR NEW.site_address IS NOT OLD.site_address
      OR NEW.about_object IS NOT OLD.about_object OR NEW.about_id IS NOT OLD.about_id
      OR NEW.title IS NOT OLD.title OR NEW.notes IS NOT OLD.notes
      OR NEW.quote_id IS NOT OLD.quote_id OR NEW.order_id IS NOT OLD.order_id
      OR NEW.payment_terms_days IS NOT OLD.payment_terms_days
      OR NEW.issued_on IS NOT OLD.issued_on OR NEW.issued_at IS NOT OLD.issued_at
      OR NEW.net_total IS NOT OLD.net_total OR NEW.tax_total IS NOT OLD.tax_total
      OR NEW.total IS NOT OLD.total OR NEW.tax_by_rate IS NOT OLD.tax_by_rate
      OR NEW.business IS NOT OLD.business
      OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' AND NEW.number IS NULL
      THEN RAISE(ABORT, 'core_document_number')
    WHEN NEW.number_seq IS NOT OLD.number_seq AND (OLD.number_seq IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM core_document_counter c WHERE c.series = 'invoice'
        AND NEW.number_seq = c.next_number - 1
        AND NEW.number IS c.prefix || printf('%04d', NEW.number_seq)))
      THEN RAISE(ABORT, 'core_document_number')
  END;
END;

CREATE TRIGGER core_invoice_no_delete
BEFORE DELETE ON core_invoice
WHEN OLD.state != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

CREATE TRIGGER core_invoice_line_insert
BEFORE INSERT ON core_invoice_line
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_invoice_line l WHERE l.id = NEW.id)
      OR NOT EXISTS (
        SELECT 1 FROM core_invoice i WHERE i.id = NEW.invoice_id AND i.state = 'draft'
      )
      THEN RAISE(ABORT, 'core_document_immutable')
  END;
END;

CREATE TRIGGER core_invoice_line_update
BEFORE UPDATE ON core_invoice_line
WHEN NEW.id IS NOT OLD.id OR NEW.invoice_id IS NOT OLD.invoice_id
  OR NOT EXISTS (SELECT 1 FROM core_invoice i WHERE i.id = OLD.invoice_id AND i.state = 'draft')
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

CREATE TRIGGER core_invoice_line_delete
BEFORE DELETE ON core_invoice_line
WHEN EXISTS (SELECT 1 FROM core_invoice i WHERE i.id = OLD.invoice_id AND i.state != 'draft')
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

-- --- Credit notes ---------------------------------------------------------------------------

CREATE TRIGGER core_credit_note_new
BEFORE INSERT ON core_credit_note
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_credit_note n WHERE n.id = NEW.id)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' OR NEW.number IS NOT NULL OR NEW.number_seq IS NOT NULL
      OR NEW.version != 0
      THEN RAISE(ABORT, 'core_document_new')
  END;
END;

CREATE TRIGGER core_credit_note_update
BEFORE UPDATE ON core_credit_note
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.version IS NOT OLD.version + 1
      AND NEW.person_id IS OLD.person_id AND NEW.organisation_id IS OLD.organisation_id
      THEN RAISE(ABORT, 'core_document_stale')
    WHEN OLD.state != 'draft' AND (NEW.state = 'draft'
      OR (NEW.person_id IS NOT OLD.person_id AND NEW.person_id IS NOT NULL)
      OR (NEW.organisation_id IS NOT OLD.organisation_id AND NEW.organisation_id IS NOT NULL)
      OR NEW.number IS NOT OLD.number OR NEW.number_seq IS NOT OLD.number_seq
      OR NEW.invoice_id IS NOT OLD.invoice_id
      OR NEW.currency IS NOT OLD.currency OR NEW.tax_mode IS NOT OLD.tax_mode
      OR NEW.bill_to_name IS NOT OLD.bill_to_name OR NEW.bill_to_address IS NOT OLD.bill_to_address
      OR NEW.bill_to_tax_number IS NOT OLD.bill_to_tax_number
      OR NEW.bill_to_email IS NOT OLD.bill_to_email
      OR NEW.reason IS NOT OLD.reason OR NEW.settle IS NOT OLD.settle
      OR NEW.issued_on IS NOT OLD.issued_on OR NEW.issued_at IS NOT OLD.issued_at
      OR NEW.net_total IS NOT OLD.net_total OR NEW.tax_total IS NOT OLD.tax_total
      OR NEW.total IS NOT OLD.total OR NEW.tax_by_rate IS NOT OLD.tax_by_rate
      OR NEW.business IS NOT OLD.business
      OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by)
      THEN RAISE(ABORT, 'core_document_immutable')
    WHEN NEW.state != 'draft' AND NEW.number IS NULL
      THEN RAISE(ABORT, 'core_document_number')
    WHEN NEW.number_seq IS NOT OLD.number_seq AND (OLD.number_seq IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM core_document_counter c WHERE c.series = 'credit_note'
        AND NEW.number_seq = c.next_number - 1
        AND NEW.number IS c.prefix || printf('%04d', NEW.number_seq)))
      THEN RAISE(ABORT, 'core_document_number')
  END;
END;

CREATE TRIGGER core_credit_note_no_delete
BEFORE DELETE ON core_credit_note
WHEN OLD.state != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

CREATE TRIGGER core_credit_note_line_insert
BEFORE INSERT ON core_credit_note_line
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_credit_note_line l WHERE l.id = NEW.id)
      OR NOT EXISTS (
        SELECT 1 FROM core_credit_note n WHERE n.id = NEW.credit_note_id AND n.state = 'draft'
      )
      THEN RAISE(ABORT, 'core_document_immutable')
  END;
END;

CREATE TRIGGER core_credit_note_line_update
BEFORE UPDATE ON core_credit_note_line
WHEN NEW.id IS NOT OLD.id OR NEW.credit_note_id IS NOT OLD.credit_note_id
  OR NOT EXISTS (
    SELECT 1 FROM core_credit_note n WHERE n.id = OLD.credit_note_id AND n.state = 'draft'
  )
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

CREATE TRIGGER core_credit_note_line_delete
BEFORE DELETE ON core_credit_note_line
WHEN EXISTS (
  SELECT 1 FROM core_credit_note n WHERE n.id = OLD.credit_note_id AND n.state != 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'core_document_immutable');
END;

-- --- What dashboards and query.sql read -----------------------------------------------------
--
-- Numbers, states, dates, amounts and the bill-to's ids: never an address, a tax number, an
-- email, the title or the notes, and never the snapshot of the business (its bank details).
CREATE VIEW rec_quote AS
SELECT
  id, number, state, currency, tax_mode, person_id, organisation_id, about_object, about_id,
  valid_until, deposit_kind, deposit_value, net_total, tax_total, total, replaces_quote_id,
  sent_at, accepted_at, declined_at, withdrawn_at, expired_at, created_at, updated_at
FROM core_quote;

CREATE VIEW rec_invoice AS
SELECT
  id, number, state, kind, currency, tax_mode, person_id, organisation_id, about_object, about_id,
  quote_id, order_id, payment_terms_days, issued_on, due_on, issued_at, sent_at,
  allow_part_payments, reminders_paused, net_total, tax_total, total, created_at, updated_at
FROM core_invoice;

CREATE VIEW rec_credit_note AS
SELECT
  id, number, state, invoice_id, currency, tax_mode, person_id, organisation_id, settle,
  issued_on, issued_at, net_total, tax_total, total, created_at, updated_at
FROM core_credit_note;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1030'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1030;
