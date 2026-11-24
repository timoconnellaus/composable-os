# @composable-os/gatekeeper-text

The text message gatekeeper (Worker `cos-gatekeeper-text`), stage 30 step 3
([ADR 0672](../../docs/adr/0672-the-text-gatekeeper.md), and
[ADR 0673](../../docs/adr/0673-which-number-is-textable.md) for which number is textable). The
business sends its routine texts and checking codes from its own number, through **its own** text
provider account: we never resell texts.

- **Only the host sends a text.** Its routine messages, its phone check and its events hook each
  reach this gatekeeper through a queue the integration host opened for that purpose
  (`hostPurpose`: `routine-mail`, `phone-check`, `text-events`). Every other caller (a person, an
  extension, an automation's own call, the assistant, MCP, Code Mode) is refused, not reviewed.
- **The provider's keys are this Worker's secrets only**, set by a person; the host never sees them.

One provider interface (`TextProvider` in [`src/provider.ts`](src/provider.ts)) and, in this
release, the fake provider only (development, tests and staging). A real provider is one more
module in `TEXT_PROVIDERS` and the `TEXT_PROVIDER` setting; nothing in the host changes.

## Exports

| Export | What it is |
| --- | --- |
| `GatekeeperVendor` (also the default export) | The vendor entrypoint, auto-provisioned (no connect flow). Its `fetch` serves the provider's webhook. |
| `TextAccount` | The account. `getGatekeeperClassFor("text://sender")` returns the facet class once a provider and the sender number are set up, else says what to set. |
| `TextGatekeeper` | The facet (`Gatekeeper<TextSession>`): the action journal of sends, the idempotency keys, the per-number code count. |
| `TextHookController` | The `HookController` the session's `subscribe` passes to `bindHook()`. |
| `TextEvents` | One Durable Object (`idFromName("events")`): seen event ids, the host keys of sent texts, the numbers that replied STOP (SHA-256 only), HELP's once a day, and the hook's delivery queue. |
| `FakeTextLedger` | The fake provider's phones: what it "sent" and the codes. |
| `FakeTextControl` | Reads the fake's phones, for tests and local development; refused unless the fake is the provider. No deployment binds it. |
| `TextVerifier` | The trivial `GatekeeperUserVerifier`. |

The session's types are in [`src/types.d.ts`](src/types.d.ts), served by `getTypeScriptTypes()`.

## Resource and session

One resource, **Sender number**, `text://sender` (binding name `TEXT`, session type `TextSession`,
hook type `TextEventHook`).

| Method | Queue | What it does |
| --- | --- | --- |
| `send({ to, text, business, idempotencyKey })` | `routine-mail` | One text, plain words of at most two segments to one number in international form. `text.routine` when the host decided it routine and it has routine shape (begins with the business's name, every link on the business's site); else `text.send`, reviewed by a person with the number partly masked. Neither is auto-approvable. |
| `startCheck({ to })` | `phone-check` | A checking code from the provider to `to`; three a day per number; refused to a number that replied STOP. |
| `check({ to, code })` | `phone-check` | Whether the code matches (each code checks once). |
| `subscribe(hook)` | `text-events` | Binds the host's hook for verified receipts and replies. |

At most 500 sends wait for a decision; a full pool refuses the send (the host's row stays ready).
An applied send to a number that replied STOP is refused before anything is sent.

## Routes

Under `BASE_URL`, proxied by the CRM from `https://<crm-origin>/gatekeeper/text/*`, bypassing
Access (the provider calls it).

| Route | Answer |
| --- | --- |
| `POST {base}/in/<provider>` | The configured provider's webhook only (any other `404`). `200 {"ok":true}` once stored, `{"duplicate":true}` for an event id seen before, `401` with a fixed reason for a bad signature, `405` not a POST, `413` over 64 KB. |

A receipt reaches the host with the host's key (`routine:<row id>`); STOP (and `STOPALL`,
`UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `OPTOUT`) and START (`UNSTOP`, `OPTIN`) change the stop list
here and reach the host; HELP (`INFO`) is answered with a fixed text naming the business, once a
day per number. Any other reply is dropped unread.

The fake's webhook body is `{ id, events: [{ type: "receipt", ref, status, costMinor? } | { type: "reply", from, text }] }`,
signed in the header `x-fake-signature: t=<unix seconds>,v1=<hex>` with HMAC-SHA256 over
`${t}.${body}` (`signFakeWebhook` in `src/fake.ts`).

## Vars and secrets

| Name | Kind | What |
| --- | --- | --- |
| `BASE_URL` | var (derived by `cos deploy`) | The public base, `https://<host>/gatekeeper/text`. |
| `TEXT_PROVIDER` | var (`product.ts`) | The provider module. Empty: none, and no text goes. `fake` only in an environment marked `live: false`. |
| `TEXT_SENDER_NUMBER` | var (`product.ts`) | The business's own number, international form. |
| `FAKE_WEBHOOK_SECRET` | secret (generated) | The fake's signing secret, generated by `cos deploy` where the fake is on. Without it the fake runs on localhost only. |

A real provider's keys are its module's secrets, listed in `deploy-inputs.json` when it is added.
