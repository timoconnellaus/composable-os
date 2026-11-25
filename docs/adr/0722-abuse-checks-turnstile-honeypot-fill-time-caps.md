# ADR 0722: Abuse checks: Turnstile, the honeypot, the fill time, caps, spam kept as success

Status: accepted, 2026-11-24 (stage 29, build step 2). Builds on
[ADR 0720](0720-the-intake-door-one-public-write.md) and the edge rule of `docs/deploying.md`
("Public calls: a rule at the edge").

## Context
A form anyone can send is a target for scripts. A puzzle for every visitor costs real enquiries,
and the host keeps no client address. The site's own call form already uses a honeypot and a rate
limit; the platform's door needs its own checks, in the host, for every way in.

## Decision
`intake.submit` checks, in this order:

1. **The edge rule** (per client address, at the zone) has counted the call before it arrives.
2. **The form takes answers from this caller** (ADR 0720), else not found.
3. **Turnstile, for the public.** The caller passes the widget's token; the host verifies it with
   Cloudflare (`siteverify`) using `TURNSTILE_SECRET_KEY`, an optional, env-only secret of
   cos-runner, where a pack's tool and so the door run. A bad or missing token is refused
   (`rule: "turnstile"`); Cloudflare unreachable is "try again shortly" (`rate_limited`). With no
   secret, public submissions are refused (`rule: "intake_unavailable"`) and admins are told once a
   day. Signed-in customers and staff are not asked.
4. **The honeypot and the fill time.** A filled honeypot (anyone outside the org) and, for the
   public, a form sent less than 3 seconds after it was shown, are answered `{ received: true }`
   and nothing is stored. When it was shown is a **token the host makes**: `intake.open` gives
   `v1.<ms>.<HMAC-SHA256 over the form id and the moment>`, keyed by a key derived from the
   Turnstile secret (HKDF, its own label). A missing, forged or another form's token counts as
   failing; one older than 24 hours is refused with "load it again" (`rule: "intake_reload"`).
5. **Caps**: 200 submissions an hour per deployment, across every form, and the form's own
   `dailyCap` per 24 hours. Over either, the caller gets "try again later" (`rate_limited`,
   `rule: "intake_cap"`) and admins are told once (an hour for the deployment, a day for a form).
6. **The answers** against the version (ADR 0720).
7. **A sixth submission in 24 hours to one form from one mailbox** (`mailboxKey`, which folds
   `+tags` and dots) is kept in the submission's `spam` state and answered as a real one.

The counts are of live submissions (`deleted_at IS NULL`), so they use the submission object's
indexes, which the reconciler makes partial on it; the Forms pack declares indexes on `created_at`
and the form (step 3). A trashed submission no longer counts.

A notice that comes with a refusal (no secret, a cap) is written at once, outside the call's batch,
so it survives the refusal; its dedupe key keeps it to once. The secret lives only in the runtime
object the runner hands the `intake.*` handlers (`IntakeRuntime`, `packages/core/src/intake/`):
never in an input, an output, D1 or the audit log. **No client address, user agent or device
fingerprint is read or stored**: the door is never given one, and Turnstile is not sent the
client's address.

## Considered
- **A signing secret of its own, or one in D1**: one more secret to set on every deployment, or a
  secret readable with the database. The Turnstile secret is already what a host taking public
  answers must have; a host without it takes none, so it needs no key. Customers skip the fill
  time, as they skip Turnstile: they are signed in and limited per account.
- **A Workers rate limit binding for the caps**: its window is at most 60 seconds and its count
  per location. The caps are counted from the submissions themselves, exactly, per hour and day.
  Two submissions at the same moment may both pass the last place under a cap; a cap is a guard
  against floods, not a promise.
- **An admin setting to turn Turnstile off on testing hosts**: a testing host uses Cloudflare's
  documented test keys instead (a secret that always passes). The hourly cap is the platform's
  default; making it and spam retention settings is the Forms pack's (step 3).

## Consequences
- The per-mailbox rule counts typed addresses: anyone who types a member's address five times to
  one form makes the member's own next answer to it spam (answered as success, kept for staff to
  mark as not spam). Accepted: the alternative, trusting a typed address, is worse.
- A deployment opening a form to the public sets `TURNSTILE_SECRET_KEY` on cos-runner and puts the
  site key in its client app (`docs/deploying.md`, "Forms: Turnstile").
- Turnstile with a real site key on a real hostname is not yet tried on a live host.

## Amended 2026-11-24, stage 29 step 3 ([ADR 0726](0726-the-forms-pack-forms-submissions-and-who-reads-them.md))
- The hourly cap is the form pack's setting when its form declares `intake.hourlyCap`: a number
  setting the contract requires to be `personApproves`, so an AI's change waits for a person. Left
  out or empty, 200. Forms' `hourlyCap` defaults to 200 (1 to 10,000). Spam retention is a setting
  of step 7, with the purge.

## Amended 2026-11-25 ([ADR 0940](0940-a-rate-limit-per-client-address-for-public-operations.md))
Step 1 is now the host's own: the pipeline counts `intake.submit` per client address (10 a minute)
and `intake.open` (30 a minute), inside the Forms pack's tool too, before the checks here, with the
visitor's address the client app passes over the binding. The door itself is still never given an
address: the pipeline counts a keyed hash of it in the rate limiting binding, and nothing about it
is stored by the door or in a submission. The caps here stay.
