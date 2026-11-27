# ADR 0960: A client's screens are published versions, and one desktop app loads them

Status: accepted as a direction, 2026-11-27 (the owner, in conversation, after two checks: the
Worker Loader documentation as it stood that day, and a spike of a desktop wrapper on Electrobun
2.0.6). Builds on [ADR 0610](0610-three-homes-for-a-client-hosted-by-default.md),
[ADR 0611](0611-one-host-a-database-per-client.md),
[ADR 0403](0403-http-surface-and-typed-client.md),
[ADR 0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md) and
[ADR 0455](0455-staff-invites-and-native-sign-in-by-tokens.md). Proposed in stages
[75](../stages/75-screen-versions.md) and [76](../stages/76-desktop-app.md); nothing here is built,
and each stage has its own interview.

## Context
The owner wants a client to be able to change its product with as little friction as possible,
and asked whether this would work: every client starts on the shared host; a client that wants to
customise is moved to a Worker of its own in a Workers for Platforms namespace, so it can add
gatekeepers; and "the app" runs under Worker Loader so it can be changed at runtime. A desktop
app, with its screens inside it and the web version still offered, was added to the question.

What was known or found:

- **Moving a client's host into a namespace was already tested and refused** (stage 46 step 1,
  ADR 0611): namespace Workers cannot bind to each other, consume a queue or run a Workflow. It is
  also not needed for a gatekeeper: ADR 0611 leaves room for a client's own gatekeeper as one more
  Worker in the namespace, called by the shared runner for that client only.
- **The host cannot run under Worker Loader.** It owns Durable Objects, queue consumers,
  Workflows and crons, which a loaded Worker has none of, and it holds identity and policy.
- **A client's web app can.** Cloudflare documents a full-stack app as a loaded Worker: the
  parent loads the server code by an id and serves the static files over a binding. A loaded
  Worker is given only values and service stubs, which is all a client's web Worker has (its
  `HOST` binding). Loaded Workers were in open beta on the paid plan; no limit on code size or
  start-up time is documented, their logs are dropped unless a tail Worker keeps them, and each
  distinct id and code is charged per day it is loaded.
- **A desktop app with its screens inside it has no server and no binding.** It reaches the host
  as the mobile app does: `/api/v1`, the typed client, tokens from a sign-in in the system browser.
- **The spike** ([record](../spikes/0002-desktop-wrapper.md): a throwaway Electrobun 2.0.6 app,
  macOS 26, the system webview; its code was not kept) showed that one
  wrapper can download a bundle, check an Ed25519-signed manifest and each file's SHA-256, keep it
  on disk and serve it to a webview with no network:
  - Serving from a folder per client (`viewsRoot`, the version in the path) works: its own origin
    per client, modules, `fetch` of its own files, a change of version without a restart, and no
    read outside the client's folder. Cookies do not work there and a reload on a history route
    fails. Electrobun's `appdata://` scheme serves the whole data folder and is not safe.
  - A storage partition per client keeps local storage and IndexedDB apart and survives a
    restart. The native library says partitions need macOS 14; below it they fall back to one
    store (read from the binary, not tested).
  - Each view can have its own bridge to the wrapper's main process, and a view's declared bridge
    held. Electrobun's own internal bridge did not: a page that is not sandboxed could run script
    in the wrapper's trusted page and in another client's view. Replacing those internal handlers
    with refusals stopped every attempt, but that object is not part of Electrobun's public
    interface. Electrobun's `sandbox` closes it too and removes the declared bridge with it.

## Decision
- **No client's host moves.** Every hosted client stays on the shared host (ADR 0611). The three
  tiers stand. A client's own gatekeeper is a Worker in the namespace when one is needed.
- **A client's screens are built as a browser-only app** that calls the host over `/api/v1` with
  the typed client. The server-rendered site is a second build of the same screens, not the only
  one.
- **Built screens are stored as versions, per client, and one of them is published.** Publishing
  is an operation that moves a pointer; going back is moving it again. A draft version can be
  used, by someone signed in and allowed to, at a preview address before it is published.
- **A preview runs on the client's live data.** A change that needs the data to change (a field,
  an operation, an extension) is tried in the client's staging environment (ADR 0450), not in a
  preview.
- **How the web serves a version is decided by a spike:** Worker Loader with the client's real
  built app, measured for size and cold start. If it does not pass, the namespace Worker carries
  the same versions with a slower publish. The version store does not depend on which.
- **The desktop app is one signed wrapper for every client** that downloads the client's
  published version, checks it against a key built into the wrapper, keeps it on disk and shows
  it from there. The wrapper's main process is ours alone and holds the tokens; a client's
  screens get a fixed list of calls to it and separate storage. The wrapper updates itself apart
  from the screens. A client that wants its own name on the app gets the same wrapper built with
  its name and icon.
- **The first desktop app loads only versions we built.** A client's own code runs in it only
  once the internal bridge can be switched off for a view by an option of Electrobun's own, or by
  a fork we keep. Until then the wrapper refuses those internal calls itself, the Electrobun
  version is pinned, and the spike's attempts are kept as tests that run on every change of that
  version.
- **The desktop app does not wait for a need for the machine** (a printer, a card reader). It is
  built after the versions are, as its own stage.

## Consequences
- **The largest work is the browser-only build,** not the desktop app. A screen that reads through
  the web app's binding or its cookie has to read through the typed client.
- **Desktop screens use hash routes and no cookies.**
- **A desktop user can be on older screens than the host.** The versioned contract (ADR 0417) and
  its "upgrade required" answer carry that, as for the mobile app.
- **A hosted bespoke client could publish its own screens.** ADR 0610 says it cannot deploy by
  itself because an account token cannot be limited to one client; publishing a version needs no
  account token. Whether it may is stage 75's question.
- **The mobile app does not get this.** Its screens go through the stores (stage 63).
- **We depend on an internal of Electrobun** until it has the option, and on Worker Loader while
  it is in beta if the spike chooses it.
- **Refused:** a host per client in a namespace; the host under Worker Loader; a desktop build
  per client as the default; Electrobun's `appdata://`; a local web server in the wrapper as the
  default (it works, and is kept as the fallback for a client that needs cookies or history
  routes).

## Amended 2026-11-27: the interview's answers
From the owner's answers to stages 75 and 76 the same day:
- **The desktop app is for staff first,** on macOS first. So the admin's staff screens build as
  a browser-only app and are a published version too, not only a client's web app.
- **An organisation can have its own admin screens.** A screen is a saved record of which block
  fills each region; a block has regions of its own, which a fill adds to or replaces. First answered
  as "a screen is code that we build", and reversed by the owner the same day.
- **What fills a region is a standard block or a custom one.** A standard block is named, not
  copied, and is updated by a release. A custom block is the organisation's code, built by a
  build service of ours in a sandbox. A release checks every saved screen against the blocks'
  regions, and one that no longer fits stops the update.
- **A person at the client with the publish permission may publish.**
- A screen made only of standard blocks is shown in the desktop app from the start. A custom
  block stays out of it until the internal bridge can be closed for a view, as decided above for
  any code that is not ours.
- What this note says of the admin's screens, regions, custom blocks and the build service is
  specified in [stage 77](../stages/77-admin-screens.md), moved out of stage 75 the same day.
