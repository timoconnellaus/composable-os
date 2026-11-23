-- Migration 0854: the copy of a signed agreement (stage 44 step 4, ADR 0645). Nothing here touches
-- core_write_guard.
--
-- Each acceptance by a person is emailed to them once, as the host's own mail, with the signed
-- PDF the email gatekeeper makes. Whether it went is kept here, beside the acceptance, so the
-- acceptance itself never changes (migration 0851's triggers are untouched). One row per
-- acceptance, made:
--   - by trigger, when a person agrees for themselves or as a guardian (`self`, `guardian`), to
--     the address the acceptance holds (their account's sign-in address);
--   - by trigger, when a guest's acceptance settles to its purchase's Person (migration 0853), to
--     the address the purchase was made with (ADR 0644: it is evidence of that purchase only);
--   - by `agreement.copy.send`, when staff press "Email a copy" of a paper form, to an address the
--     host holds for the Person it is for.
-- Triggers, so every writer and every path makes it in the batch that records the acceptance.
--
-- Where a copy goes is the host's records', never a caller's: the insert trigger checks the
-- address against the acceptance (or, for paper, against the Person's own addresses), and no
-- update can change it, except erase clearing it. What may change is only how sending went.
--
-- (Edited in place after the review of PR #283, before it merged: `next_at` is set on every row
-- the sender still has work for, so each state's due rows are read in index order and a read
-- stops at its limit; a paper copy's account address must be a linked account's, as the code
-- reads it; erase clears the address.)

CREATE TABLE core_agreement_copy (
  acceptance_id TEXT PRIMARY KEY,
  -- Cleared (null) when the acceptance is erased.
  to_address TEXT CHECK (to_address IS NULL OR length(to_address) BETWEEN 3 AND 320),
  -- queued: to send; sending: one sender has claimed it; sent: the gatekeeper applied it;
  -- waiting: held for a person's approval (asked again until it is sent or turned down);
  -- failed: refused, or the outcome unknown (never sent twice); cancelled: the acceptance was
  -- erased before it went.
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'waiting', 'failed', 'cancelled')),
  -- The idempotency key of the current try: `agreement-copy:<acceptance id>`, and a new one only
  -- after a try the gatekeeper proved was not sent (ADR 0574).
  send_key TEXT NOT NULL CHECK (send_key LIKE 'agreement-copy:%'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at TEXT NOT NULL,
  -- When the sender next looks at it: queued and waiting rows when due, a sending row when its
  -- claim goes stale. Every row the sender still has work for has one.
  next_at TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  pending_action_id TEXT,
  -- What went wrong, as a category (`queue_full`, `refused`, …): never the gatekeeper's or the
  -- provider's words, which may name the recipient. Cleared on erase.
  error TEXT CHECK (error IS NULL OR length(error) <= 500),
  -- Paper: the staff user who pressed "Email a copy".
  requested_by TEXT,
  CHECK (state NOT IN ('queued', 'sending', 'waiting') OR next_at IS NOT NULL),
  CHECK (to_address IS NOT NULL OR state IN ('cancelled', 'sent', 'failed'))
);
CREATE INDEX core_agreement_copy_due_idx ON core_agreement_copy (state, next_at);

-- What may be inserted: never over an existing row (no REPLACE, no upsert); only for an
-- acceptance that exists and is not erased; queued and due, with the first key; to the
-- acceptance's own address, or for paper to an address the host holds for its Person (an active,
-- linked customer account's sign-in address, or one of the Person's addresses), compared without
-- case.
CREATE TRIGGER core_agreement_copy_new
BEFORE INSERT ON core_agreement_copy
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_copy c WHERE c.acceptance_id = NEW.acceptance_id)
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.state != 'queued' OR NEW.attempts != 0 OR NEW.sent_at IS NOT NULL
      OR NEW.next_at IS NULL OR NEW.to_address IS NULL
      OR NEW.send_key != 'agreement-copy:' || NEW.acceptance_id
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NOT EXISTS (
      SELECT 1 FROM core_agreement_acceptance a
      WHERE a.id = NEW.acceptance_id AND a.erased_at IS NULL AND a.person_id IS NOT NULL
        AND (
          (a.by != 'paper' AND a.email IS NOT NULL AND lower(a.email) = lower(NEW.to_address))
          OR (a.by = 'paper' AND (
            EXISTS (SELECT 1 FROM core_customer c WHERE c.person_id = a.person_id
              AND c.status = 'active' AND c.link_state = 'linked'
              AND lower(c.email) = lower(NEW.to_address))
            OR EXISTS (SELECT 1 FROM core_person_emails e WHERE e.person_id = a.person_id
              AND lower(e.email) = lower(NEW.to_address))))
        )
    )
      THEN RAISE(ABORT, 'core_agreement_copy_address')
  END;
END;

-- Who it is for, when it was asked for and by whom never change; where it goes changes only to
-- nothing, once its acceptance is erased; a copy sent stays sent.
CREATE TRIGGER core_agreement_copy_no_update
BEFORE UPDATE ON core_agreement_copy
BEGIN
  SELECT CASE
    WHEN NEW.acceptance_id IS NOT OLD.acceptance_id
      OR NEW.queued_at IS NOT OLD.queued_at OR NEW.requested_by IS NOT OLD.requested_by
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.to_address IS NOT OLD.to_address AND NOT (NEW.to_address IS NULL
        AND EXISTS (SELECT 1 FROM core_agreement_acceptance a
          WHERE a.id = OLD.acceptance_id AND a.erased_at IS NOT NULL))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.state = 'sent' AND NEW.state != 'sent'
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
  END;
END;

-- A person agreeing (for themselves, or as a guardian for a child), signed in: the copy goes to
-- the address the acceptance holds. Paper sends none unless staff ask; a guest's waits for its
-- purchase.
CREATE TRIGGER core_agreement_copy_on_accept
AFTER INSERT ON core_agreement_acceptance
WHEN NEW.by IN ('self', 'guardian') AND NEW.email IS NOT NULL AND NEW.person_id IS NOT NULL
BEGIN
  INSERT INTO core_agreement_copy (acceptance_id, to_address, state, send_key, attempts, queued_at,
    next_at)
  VALUES (NEW.id, NEW.email, 'queued', 'agreement-copy:' || NEW.id, 0, NEW.accepted_at,
    NEW.accepted_at);
END;

-- A guest's acceptance once its purchase settles it to a Person (migration 0853's triggers, the
-- verified payment's batch or order.setPerson's): the copy goes to the address the purchase was
-- made with, which the acceptance holds. An order that closes unpaid deletes its guest rows
-- before any copy exists.
CREATE TRIGGER core_agreement_copy_on_settle
AFTER UPDATE OF person_id ON core_agreement_acceptance
WHEN OLD.person_id IS NULL AND NEW.person_id IS NOT NULL AND NEW.by = 'guest'
  AND NEW.email IS NOT NULL AND NEW.erased_at IS NULL
BEGIN
  INSERT INTO core_agreement_copy (acceptance_id, to_address, state, send_key, attempts, queued_at,
    next_at)
  SELECT NEW.id, NEW.email, 'queued', 'agreement-copy:' || NEW.id, 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NOT EXISTS (SELECT 1 FROM core_agreement_copy c WHERE c.acceptance_id = NEW.id);
END;

-- Erase (and the Trash purge): a copy not yet gone is never sent, a claimed one included, and no
-- copy keeps the address. (A copy already waiting for a person's approval is cancelled here; the
-- approval itself and the gatekeeper's journal entry are step 8's, docs/stages/44-agreements.md.)
CREATE TRIGGER core_agreement_copy_on_erase
AFTER UPDATE OF erased_at ON core_agreement_acceptance
WHEN OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
BEGIN
  UPDATE core_agreement_copy
  SET to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
    state = CASE WHEN state IN ('sent', 'failed') THEN state ELSE 'cancelled' END
  WHERE acceptance_id = NEW.id;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '854'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 854;
