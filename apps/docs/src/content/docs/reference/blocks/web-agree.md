---
title: "web-agree"
description: "Agree to one document (stage 44 step 5), for the web: the version the host gave, its words, a health form's questions, the tick label and its box, the typed name and, for a document agreed to by drawing, the signature pad."
editUrl: false
---

Agree to one document (stage 44 step 5), for the web: the version the host gave, its words, a health form's questions, the tick label and its box, the typed name and, for a document agreed to by drawing, the signature pad. "Agree" hands what the person gave to `onAgree`: a member's screen calls the host (me.agreements.accept), a visitor's keeps it for the buying call. It decides nothing: which version, whether it is due, who may agree and whether what was given is acceptable are the host's. What a person types, draws and answers stays in this component's memory (never the URL, storage or a log) and is cleared once `onAgree` succeeds.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-agree` |
| Files | `agree.tsx`, `signature-pad.tsx`, `agreement-step.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [blocks/web-agree](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-agree).
