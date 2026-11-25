---
title: "forms-native-form"
description: "A form to fill in, for the mobile app (stage 29 step 4): the native skin over the same headless entry as the web block, with every question kind the question schema has, then its thank-you."
editUrl: false
---

A form to fill in, for the mobile app (stage 29 step 4): the native skin over the same headless entry as the web block, with every question kind the question schema has, then its thank-you. `FormScreen` opens a form by its address; `LinkedFormScreen` opens a signed-in member's own personal link from Needs your attention (`me.attention`, kind form_to_fill, by the link's id): the app's prompt to answer the feedback after a class. It holds no rules: who may answer, once only, the spam checks and the caps are the host's, and its answer is the one shown; the answers are checked first with the host's own check, for the words beside each question. A member in the app is signed in, so the host asks no spam check of them; for a visitor on a public form, the app passes its Turnstile widget (`Turnstile`, in a web view), and the host's token of when the form was shown travels with the send. What a person types stays in this screen's state and nowhere else.

<img class="cos-screen cos-screen-native" src="/screens/forms-native-form.png" alt="forms-native-form, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [forms](/packs/forms/screens/) |
| Add it | `cos add forms-native-form` |
| Files | `form-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client`, `@composable-os/pack-forms` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.forms.form`](/packs/forms/tools/#form)
- [`x.forms.submit`](/packs/forms/tools/#submit)
- [`x.forms.linkedForm`](/packs/forms/tools/#linkedform)
- [`x.forms.submitLinked`](/packs/forms/tools/#submitlinked)

Source: [packs/forms/blocks/forms-native-form](https://github.com/timoconnellaus/composable-os/tree/main/packs/forms/blocks/forms-native-form).
