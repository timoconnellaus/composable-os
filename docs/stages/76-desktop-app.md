# Stage 76: The desktop app

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md) (Client app, Typed
client, Device session, Pack role), ADRs
[0960](../adr/0960-screens-as-published-versions-and-one-desktop-app.md), [0417](../adr/0417-the-api-contract-and-versions.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md) and
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md); stages
[75](75-screen-versions.md) and [63](63-app-publishing.md); the spike's record,
[`docs/spikes/0002-desktop-wrapper.md`](../spikes/0002-desktop-wrapper.md); code:
`templates/client/apps/mobile/src/host.ts` (token sessions and the browser sign-in),
`packages/client/src/client.ts` (`onUpgradeRequired`).

Status: **spec proposed (2026-11-27)**. Not built until its interview settles the questions at its
end.

## Goal

A real desktop app for a client's product: installed, opened from the dock, its screens on the
machine so it opens with no network. One signed app serves every client. It shows the client's
published screens (stage 75) and gets a new version of them without an update of the app. The web
version stays.

## What exists today (from the code)

- **No desktop app.** The native client is the mobile app (Expo), with screens of its own.
- **Native sign-in exists:** an emailed code, or the system browser with PKCE and a redirect to
  the app's scheme, answering with tokens (ADRs 0451, 0455). A desktop app can use it unchanged.
- **The spike** (ADR 0960) ran one Electrobun 2.0.6 wrapper on macOS with two made-up clients: a
  downloaded, signed bundle served from disk, storage kept apart, a bridge per view, and the hole
  in Electrobun's internal bridge with the patch that closed it.
- **A working Electrobun app of the owner's** (another project) has the pieces a wrapper needs
  and this spec reuses its approach: tokens only in the main process and the Keychain, the
  browser sign-in with its scheme, a checked self-update, signing, notarising and a release
  workflow.

## Decided by the owner (2026-11-27)

| # | Decision |
| --- | --- |
| 1 | One wrapper for every client, which loads a client's screens at runtime; not a build per client |
| 2 | The screens are inside the app, not a website shown in a window; the web version stays |
| 3 | It is built after stage 75 and does not wait for a need for the machine (a printer, a card reader) |
| 4 | The first version loads only screens we built (ADR 0960) |

## The design in one page

```
 the wrapper (signed, ours)
 ┌──────────────────────────────────────────────────────────────┐
 │ main process: tokens (Keychain), downloads, checks, updates   │
 │      ▲ a fixed list of calls, per view                        │
 │ ┌────┴──────────────┐  ┌───────────────────┐                  │
 │ │ client A's screens │  │ client B's screens │  own storage,   │
 │ │ from disk, v7      │  │ from disk, v3      │  own folder     │
 │ └───────────────────┘  └───────────────────┘                  │
 └──────────────────────────────────────────────────────────────┘
        │ /api/v1 with the client's token          │ published version, signed
        ▼                                          ▼
                       the client's host
```

## The model

- **The wrapper** is one app on Electrobun, signed and notarised by us. Its main process is ours
  alone: no downloaded code runs there.
- **Choosing a client.** A person adds a client by its address or by a link from that client;
  the wrapper asks the host at that address who it is and signs the person in through the system
  browser. A person can have several clients and switch between them.
- **Loading screens.** The wrapper asks the client's host for the published version, downloads
  the files it does not have, checks the manifest's signature against a key built into the
  wrapper and every file's hash, and only then moves the version into that client's folder. A
  version is checked again when it is loaded from disk. Screens are shown from the folder, one
  folder and one origin per client, each version at its own path.
- **A new version** is fetched in the background and used at the next launch, or at once when
  the person agrees. With no network the last version opens.
- **Storage** is one partition per client. The app does not install below macOS 14.
- **Tokens** stay in the main process and the Keychain, per client. The screens call the host
  through the main process and never hold a token.
- **The bridge** is a fixed list per view, in the wrapper's code: call the host, the session, open
  a link in the browser, and what later stages add for the machine. Electrobun's internal calls
  that reach another view are refused by the wrapper, a view cannot leave its own folder, and
  the spike's attempts run as tests on every change of the Electrobun version.
- **Old screens, new host.** Each version names the oldest wrapper it works with; the host's
  "upgrade required" answer (ADR 0417) is shown as it is in the mobile app.
- **The wrapper updates itself** from our release address, checking our signature on what it
  downloads before it is applied.
- **A client's own name on the app** is the same wrapper built with its name and icon, signed by
  us, for a client that asks.

## Out of scope

- A client's own code in the wrapper (ADR 0960: after the internal bridge can be closed by an
  option of Electrobun's or a fork).
- Printers, card readers, a locked kiosk, files: later stages add calls to the bridge.
- Working on records with no network: the screens open offline; the data is the host's.
- The Mac App Store.
- Windows and Linux, unless the interview says otherwise (question 2).

## Acceptance criteria

1. One signed, notarised app installs on macOS 14 or later and refuses below it.
2. A person adds a client by address, signs in through the browser and sees that client's
   published screens, served from disk.
3. With no network the app opens the last version it had.
4. A version with a wrong signature or a changed file is not shown, at download and at load.
5. After `screens.publish` the wrapper shows the new version at the next launch, with no update
   of the app.
6. Two clients in one app cannot read each other's storage, files or token (tests on the real
   webview).
7. A view cannot call anything outside its list, run script in another view or in the wrapper's
   own page, or go to an address outside its folder: the spike's attempts all fail.
8. No token is reachable from a page.
9. The wrapper updates itself, and refuses an update not signed by us.

## Dependencies

Stage 75 (versions, publishing, the browser-only build). An Apple developer account for signing.

## Migrations and numbers

Block CE with stage 75. No migration is expected.

## Suggested build order

1. **The wrapper's skeleton:** the app, one client added by address, sign-in in the browser,
   tokens in the Keychain, the bridge's first calls, screens bundled for now.
2. **Screens from the host:** download, the checks, the folder per client, offline, a new
   version at launch.
3. **Several clients:** partitions, switching, the isolation tests on the real webview.
4. **The bridge closed:** the refusals of Electrobun's internal calls, navigation kept to the
   folder, the attempts as tests; the request to Electrobun for an option.
5. **Release:** signing, notarising, the self-update with its check, the download page.
6. **Docs and the site.**

## Decided by this spec, open to override

- **Electrobun, on the system webview,** as the owner's other project uses it. No bundled
  browser engine.
- **Hash routes and no cookies** in desktop screens.
- **We ask Electrobun for an option** that switches its internal bridge off for a view, and
  refuse those calls ourselves until it exists.
- **The signing key for versions is ours,** one per environment, its public half in the wrapper.
- **The download is direct,** from our address.

## Questions for the owner

1. **Who is the desktop app for first?** Staff, or a client's customers. Recommended: staff.
   This decides more than anything else here: staff work in the admin, whose screens are ours
   and are not a client's published version today (stage 75, question 1), so a staff desktop app
   means the admin's screens build browser-only too.
2. **Is Windows needed at the start?** Recommended: macOS first, Windows as the next step. A
   front desk often runs Windows, and nothing about Windows has been tested: it uses a different
   webview, and storage, schemes and signing all have to be proved again.
3. **What is the app called?** It is one app for every client, so its name in the dock is ours,
   not the client's. Recommended: the product's name where a product has one app for all its
   clients, and "Composable OS" otherwise.

## Status

Spec proposed (2026-11-27). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 75 step 2 — The wrapper's skeleton

- **Step 2** — not built — needs: step 1, stage 75 step 4 — Screens from the host

- **Step 3** — not built — needs: step 2 — Several clients

- **Step 4** — not built — needs: step 3 — The bridge closed

- **Step 5** — not built — needs: step 4, an Apple developer account — Release

- **Step 6** — not built — needs: step 5 — Docs and the site
