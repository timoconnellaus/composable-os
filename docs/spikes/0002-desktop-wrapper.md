# Spike 0002: one desktop wrapper that loads a client's screens

Spike for [ADR 0960](../adr/0960-screens-as-published-versions-and-one-desktop-app.md) and
[stage 76](../stages/76-desktop-app.md). Date: 2026-11-27. The code was thrown away and is not in
the repository (the owner's decision); this record holds what a build needs from it.

## What was built

One Electrobun app, a dev build, unsigned, that ran itself four times with no one clicking and
wrote what each page and the main process saw to log files:

- Two made-up clients (A with two versions, B with one), each an `index.html`, a script, a
  stylesheet, an image and a JSON file, served by a local server standing in for the host. A
  third and fourth version of A were tampered with: one changed file, one bad signature.
- The main process downloaded a manifest and its Ed25519 signature, checked the signature with
  a public key compiled into the app, downloaded each file into a staging folder, checked each
  SHA-256, and moved the folder into the cache only when all matched.
- A trusted page of the wrapper's own with a privileged call (`readSecret`), and a view per
  client with two harmless calls.
- The launches: serve everything with the server up; restart with the server down; attempts on
  the bridge; the same attempts with the refusals below in place.

Versions: macOS 26.5.2 on Apple silicon, Electrobun 2.0.6 (Hutch 0.29.0), Bun 1.4.4 in the app,
the system webview (WKWebView). Nothing was tested on Windows, Linux, a bundled browser engine or
a macOS before 26.

## Results

### Download and check

Worked. The changed file and the bad signature were both refused, nothing of either reached the
cache, and neither ran. The spike checked at download only; the real wrapper checks again when it
loads a version from disk.

### Serving the cache to a view

| Mechanism | Result |
| --- | --- |
| `viewsRoot` on a `BrowserView` | Works, and is the one to use |
| `appdata://` (`allowedProtocols.appData`) | Works and is unsafe: it serves the app's whole data folder to any view that has it, so client A read client B's files and files of the wrapper's own. It has no root per view |
| A server on `127.0.0.1` in the main process | Works. The fallback only |

`viewsRoot`, as found by running it:

- A URL `views://<host>/<path>` is served from `<viewsRoot>/<host>/<path>`.
- The layout that works: `viewsRoot` is `<cache>/clients/<client>`, the version's files are in
  `<cache>/clients/<client>/<client>/<version>/`, and the URL is
  `views://<client>/<version>/index.html`.
- It does not follow symbolic links: a linked version folder gave a blank view. Use real folders.
- The page's origin is `views://<client>` (lower case), a secure context. Two clients have
  different origins.
- Relative stylesheets and images, ES modules, dynamic `import()`, `fetch` of a file of its own
  and hash routes work.
- History routes do not: `pushState` works, but nothing answers a deep URL, so a reload fails.
- Cookies do not work at all: `document.cookie` stays empty.
- With the server down, the download failed, the cached version was used and every page worked.
- A change of version without a restart works by loading the other version's URL. The origin is
  the same, so storage carries over.
- Replacing the files behind one URL does not work: the view showed the new stylesheet with the
  old cached script. Each version needs its own path.
- Nothing outside the client's root could be read: another client's files, the wrapper's own
  `views://` pages, and `..` in several encodings all failed. A version can read the client's
  other versions.

The `127.0.0.1` server: a fixed port per client, and the port is the origin, so it can never
change. History routes work, since the server can answer with `index.html`. Cookies work, but
cookies ignore ports, so one client's port opened in another's partition saw its cookies. Any
local process can read from the server.

### Storage per client

- A `BrowserView` with `partition: "persist:<client>"`, attached to the window with `windowId`.
  A window's built-in view takes no partition, and is not needed for clients.
- Local storage and IndexedDB set by A were not visible to B, and both clients' values were there
  after a restart with no network.
- Controls on one origin showed the partition is what separates: another partition saw nothing,
  the same partition saw the values.
- **Below macOS 14: not tested.** The native library contains the text "Partition-specific data
  stores require macOS 14.0+, using default store", so every partition would become one store.
  Under `viewsRoot` the origins would still keep local storage and IndexedDB apart. The built
  app sets no minimum system version; the real one sets 14.0.

### The bridge

- **A bridge per view works.** Each view is given its own definition; the client views had no
  `readSecret`, and asking for it answered "no handler". The main process knows which view
  called by which definition received the call; a handler is not given a view id.
- **A view's declared bridge held.** A raw request for the undeclared call went only to the
  view's own definition. Connecting to the bridge's socket as another view got no answer.
- **Electrobun's internal bridge did not hold.** Every page that is not sandboxed can post
  Electrobun's own internal calls (the ones behind its `<electrobun-webview>` element), and they
  take the target view's id from the message:
  - `webviewTagExecuteJavascript` with the trusted page's id ran script there, which called
    `readSecret` and returned the secret. With client B's view id it read B's local storage.
  - `webviewTagInit` created a new view with any partition and any preload script. Under the
    `127.0.0.1` server this took all of B's storage. Under `viewsRoot` B's URL did not load in
    the new view, as it has no `viewsRoot`.
  - `webviewTagSetNavigationRules` with the page's own id lifted its navigation rules.
  - Others take a view id too and were not tried: `webviewTagUpdateSrc`, `webviewTagUpdateHtml`,
    `webviewTagUpdatePreload`, `webviewTagResize`, `webviewTagRemove`, `webviewTagOpenDevTools`.
- **Refusing those calls in the wrapper stopped every attempt.** The wrapper replaced
  `internalRpcHandlers.request.webviewTagInit` and
  `internalRpcHandlers.message.{webviewTagExecuteJavascript, webviewTagUpdatePreload,
  webviewTagUpdateSrc, webviewTagUpdateHtml, webviewTagSetNavigationRules}` with refusals, and
  removed any view a tag created (`BrowserView.on("created", …)`). `internalRpcHandlers` is in
  Electrobun's `sdks/main/proc/native` and is not exported, and the change applies to every view.
  The real wrapper should allow a list, not refuse a list.
- **Frames.** A frame of the same origin has no globals of its own but can use its parent's, so
  it can do what the page can. A frame of another origin cannot reach the parent. Both can see
  the message handlers, but what they posted never arrived: observed, not documented.
- **`sandbox: true`** removes the declared bridge and the internal one. The page still loads and
  a preload still runs, but it has no calls to the main process at all.
- **Navigation rules.** The `navigationRules` option when a view is created does nothing; call
  `setNavigationRules` after creating it. Rules are patterns with `*`, a leading `^` blocks, the
  last match wins and the default is allow. `["^*", "views://<client>/*"]` keeps a view to its
  own files. `["views://<client>/*"]` alone blocks nothing, and `["^*"]` blocks the page itself.
  Rules do not apply to frames.

Globals a page that is not sandboxed can see: `__electrobun`, `__electrobunBunBridge`,
`__electrobunEventBridge`, `__electrobunHostBridge`, `__electrobunInternalBridge`,
`__electrobunHostSocketPort`, `__electrobunRpcSocketPort`, `__electrobunSecretKeyBytes` (the
view's own key), `__electrobunSendToHost`, `__electrobunWebviewId`, `__electrobunWindowId`,
`__electrobun_encrypt`, `__electrobun_decrypt`, the `webkit.messageHandlers` for each bridge, and
the `<electrobun-webview>` element.

## What it means for the build

- Serve with `viewsRoot`, a root per client, real folders, the version in the path.
- A `BrowserView` per client with its own partition; macOS 14 as the minimum.
- A bridge definition per view; navigation rules set after creation.
- Refuse the internal calls from an allowed list, pin the Electrobun version, and keep each
  attempt above as a test.
- Keep the wrapper's own trusted page out of any window that shows a client's view if the
  refusals cannot be relied on.
- Ask Electrobun for an option that switches the internal bridge off for a view while keeping
  the declared one, or that checks the target view is the sender's.

## Not verified

- The internal calls listed as not tried.
- Why frames' messages are dropped.
- macOS before 14, Windows, Linux, a bundled browser engine.
- A real client's built app (the bundles were a few small files).
- The webview's own cache across versions, beyond the one case above.
