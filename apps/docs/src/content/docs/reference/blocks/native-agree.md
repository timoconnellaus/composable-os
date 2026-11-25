---
title: "native-agree"
description: "Agree to one document (stage 44 step 5), for the mobile app: the version the host gave, its words, a health form's questions, the tick label and its box, the typed name and, for a document agreed to by drawing, the signature pad."
editUrl: false
---

Agree to one document (stage 44 step 5), for the mobile app: the version the host gave, its words, a health form's questions, the tick label and its box, the typed name and, for a document agreed to by drawing, the signature pad. "Agree" hands what the person gave to `onAgree`, which calls the host (me.agreements.accept). The same logic as the web block (@composable-os/client), drawn with React Native. It decides nothing: the version, whether it is due, who may agree and whether what was given is acceptable are the host's. What a person types, draws and answers stays in this component's memory and is cleared once `onAgree` succeeds.

<img class="cos-screen cos-screen-native" src="/screens/native-agree.png" alt="native-agree, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-agree` |
| Files | `agree-screen.tsx`, `signature-pad.tsx`, `agreement-step.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/native-agree](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-agree).
