-- Migration 0916: who an address belongs to, for consent to be contacted (stage 30, ADR 0678).
--
-- The host matches the address a message is sent to with the People who hold it by the mailbox it
-- reaches, the same rule the suppression list hashes addresses by (`mailboxKey` in
-- packages/core/src/customers/limits.ts, ADR 0459): the `+tag` dropped on every domain, and on
-- gmail.com and googlemail.com the dots dropped and the domain gmail.com. So a member who stopped
-- at `john@gmail.com` is not mailed at `j.ohn+gym@googlemail.com`. Migration 0955's folded form
-- keeps dots, so this is an index of its own over an expression, nothing stored.
-- `peopleAtAddresses` in packages/core/src/visibility/guardians.ts writes the same expression (it
-- must match this one for the index to serve it); a test holds it and `mailboxKey` together.
CREATE INDEX core_person_emails_mailbox_idx ON core_person_emails (
  CASE
    WHEN substr(email, instr(email, '@') + 1) IN ('gmail.com', 'googlemail.com')
    THEN replace(
        CASE
          WHEN instr(email, '+') > 1 AND instr(email, '+') < instr(email, '@')
          THEN substr(email, 1, instr(email, '+') - 1)
          ELSE substr(email, 1, instr(email, '@') - 1)
        END,
        '.',
        ''
      ) || '@gmail.com'
    ELSE CASE
        WHEN instr(email, '+') > 1 AND instr(email, '+') < instr(email, '@')
        THEN substr(email, 1, instr(email, '+') - 1) || substr(email, instr(email, '@'))
        ELSE email
      END
  END
);
