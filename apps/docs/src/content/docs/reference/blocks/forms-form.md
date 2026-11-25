---
title: "forms-form"
description: "A form to fill in, for the business's own website (stage 29 step 4): any published form, with every question kind the question schema has, then its thank-you."
editUrl: false
---

A form to fill in, for the business's own website (stage 29 step 4): any published form, with every question kind the question schema has, then its thank-you. `FormBlock` opens a form by its address (or a personal link's token); `LinkedFormBlock` opens a signed-in member's own personal link from Needs your attention (`me.attention`, kind form_to_fill, by the link's id). It holds no rules. Whether the form takes answers from this visitor, who may answer, once only, the spam checks and the caps are the host's; required questions, lengths and links are checked before sending with the host's own check (the headless entry), and the host's answer is the one shown: a refusal stays on the screen with the answers as typed. The spam checks travel with the send: the honeypot is a field a person never sees, the time the form was shown is the host's token from opening it, and a visitor's Turnstile token comes from the widget the app passes as `Turnstile` (the block loads no script of its own). A personal link skips Turnstile at the host, so no widget is drawn for one. What a person types stays in this component's state and nowhere else. A page showing `FormBlock` for a personal link's token keeps the link page's three rules itself (ADR 0728): `Referrer-Policy: no-referrer`, no third-party script (one could read the address before the token is out), and the token taken out at once with `takeLinkToken`.

<img class="cos-screen" src="/screens/forms-form.png" alt="forms-form, drawn with dummy data" width="640" height="1000" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [forms](/packs/forms/screens/) |
| Add it | `cos add forms-form` |
| Files | `form.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client`, `@composable-os/pack-forms` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.forms.form`](/packs/forms/tools/#form)
- [`x.forms.submit`](/packs/forms/tools/#submit)
- [`x.forms.linkedForm`](/packs/forms/tools/#linkedform)
- [`x.forms.submitLinked`](/packs/forms/tools/#submitlinked)

Source: [packs/forms/blocks/forms-form](https://github.com/timoconnellaus/composable-os/tree/main/packs/forms/blocks/forms-form).
