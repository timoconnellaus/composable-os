# Publishing a client's app to the phone app stores

The runbook for a client's iPhone and Android apps (stage 63, ADRs
[0900](adr/0900-the-apps-identity-brand-and-listing-from-product-ts.md),
[0901](adr/0901-publishing-from-the-clients-store-accounts-built-in-its-ci.md) and
[0905](adr/0905-the-purchase-scan-over-a-clients-own-app-code.md)): who does what, the keys, the
first build, each release.

**Not yet tried on real store accounts.** What is built (steps 1 to 3 of the stage): the app's
identity from `product.ts`, `cos app check`, `credentials`, `build-info`, `record` and `upload`,
and the template's workflow. It was built where no store account, signing key or upload existed:
the workflow has not run, and no build has reached a store. The first client's first build
(step 9) is the first real run; correct this page with what it finds. The stores' rules change:
read each store's own guidelines again before the first submission. Anything legal (the privacy
policy's words, what the business must tell its members) is the business's, with its lawyer.

## Who does what

| Who | Does |
| --- | --- |
| **The client** | Opens an organisation developer account in each store under the business's legal name, and pays the stores' yearly fees. Keeps the accounts' passwords. Invites our person as a member who may upload and release. Says yes to each release. Can remove us, and revoke every key, at any time. |
| **A person on our side** | Makes the upload keys in the client's accounts, sets them as CI secrets, sets up the protected CI environments, approves each workflow run, submits for review, and releases to the public after the client's yes. |
| **An AI** | May write listing drafts, release notes and a draft of the privacy answers, suggest colours, run `cos app check` and open a pull request with a version bump. **Never** creates, sees, holds or sets a signing key, a store key or the deploy credential; never approves a run, submits for review or releases. |

The signing files and the store accounts' passwords are the client's: never an AI's and never in a
repository. We hold only what the stores issue for uploading, as CI secrets.

## 1. The app's identity in product.ts

`mobile.app` in the client repo's `product.ts` (ADR 0900):

```ts
mobile: {
  dir: "apps/mobile",
  app: {
    name: "Example Gym",                 // under the icon, at most 30 characters
    version: "1.0.0",                    // bumped by a pull request
    ids: { ios: "com.example.gym", android: "com.example.gym" },  // never change once published
    icon: "apps/mobile/assets/icon.png", // 1024 by 1024 PNG, opaque
    splash: { image: "apps/mobile/assets/splash.png", background: "#101010" },
    colours: { primary: "#e11d48", background: "#ffffff", text: "#18181b" },
    listing: "apps/mobile/store",
    purchases: "none",
  },
},
environments: {
  staging: { live: false, hostname: "admin.staging.example.com",
    mobile: { scheme: "gym-staging", app: { name: "Gym (staging)",
      ids: { ios: "com.example.gym.staging", android: "com.example.gym.staging" } } } },
  live: { hostname: "admin.example.com" },
},
```

The staging app installs beside the live one: its own name, ids and scheme, its host the staging
host. Each environment needs `hostname`: the app's host address is made from it. `pnpm cos client
generate` writes `apps/mobile/src/blocks/brand.ts` from the colours.

The listing, per locale (`apps/mobile/store/en-AU/`): `name.txt`, `subtitle.txt`,
`description.txt`, `keywords.txt`, `release-notes.txt`, `support-url.txt`, `privacy-url.txt` and
`screenshots/`. The privacy answers each store asks for are drafted from the operations the app
calls; a person confirms them.

Then `pnpm cos app check`. It refuses, each with what to do: ids or schemes the same in two
environments, an id other than a recorded build's (with the deploy credential), a missing or
wrong-sized icon, an icon that can be transparent, an unreadable text colour, a listing text over
a store's length, `purchases` other than `"none"`, a buying or billing operation in the app's code,
an app without "Delete my account", a key file in the repository, a `brand.ts` that is not
product.ts's, an environment without a hostname.

"Delete my account" is stage 48's native account shell; until the template wires it (stage 63
step 6), `cos app check` fails on it, and no store build can go.

## 2. The keys

`pnpm cos app credentials` lists each secret, the job that holds it and the command that sets it.
A person makes each in the client's own account and sets it; nothing prints a value.

- **The iPhone store's API key** (`IOS_STORE_API_KEY`, `_KEY_ID`, `_ISSUER_ID`): made in the
  client's account by our person (as a member allowed to), with the least role that may upload
  builds. The `.p8` file can be downloaded once: set it as the secret straight away and delete the
  file.
- **The distribution certificate** (`IOS_DISTRIBUTION_CERTIFICATE`, `_PASSWORD`): made in the
  client's account, exported with its private key as `.p12`, set in base64, the file deleted. The
  team id is `IOS_TEAM_ID`. The workflow signs automatically with the API key, so no provisioning
  profile is held.
- **The Android upload key** (`ANDROID_UPLOAD_KEYSTORE`, `_PASSWORD`):
  `keytool -genkeypair -v -storetype PKCS12 -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000`,
  set in base64. The alias must be `upload`. Use the store's own app signing: the store keeps the
  app's signing key, so a lost upload key is replaced without a new listing.
- **The Android store's upload account** (`ANDROID_STORE_SERVICE_ACCOUNT`): a service account's
  JSON key, invited to the client's store account with only the permission to release to testing
  tracks for this app.
- **The deploy credential** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`): the token
  `cos deploy` uses for this host (D1 read and write is what the app jobs need). For a hosted
  client it reaches the whole fleet (stage 46), which is why only the two `cos` jobs hold it.

Keep a copy of nothing. A leaked key is revoked in the client's account and made again.

## 3. The protected CI environments

In the client repository, two environments, each with a person as a required reviewer and
deployments only from `main` and tags `app-v*`:

- `app-upload`: the store keys (the build jobs);
- `app-record`: the deploy credential (the jobs that number and record builds).

```sh
for env in app-upload app-record; do
  gh api -X PUT "repos/<owner>/<repo>/environments/$env" --input - <<JSON
{ "reviewers": [{ "type": "User", "id": <the person's user id> }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
  gh api -X POST "repos/<owner>/<repo>/environments/$env/deployment-branch-policies" -f name=main -f type=branch
  gh api -X POST "repos/<owner>/<repo>/environments/$env/deployment-branch-policies" -f name='app-v*' -f type=tag
done
```

Repository variables: `APP_MACOS_RUNNER` (the iPhone build's runner, default `macos-latest`) and
`APP_ANDROID_DRAFT` (`true` until the Android store has published the app once: an app it has not
published takes only draft releases). In the Android store's console, turn on managed publishing,
so nothing (a listing change included) goes out until a person publishes it.

## 4. The first build

- **The Android store's first bundle** is uploaded by hand in its console (as we read its
  guidance, its API takes bundles only for an app that already has one). Build it once with the
  workflow's steps on a machine, upload it to internal testing, and record it:
  `pnpm cos app record --env live --platform android --build 1`.
- A first build on a person's own machine is allowed once, for the first client, to learn; it is
  recorded with `cos app record` too. Every build after that goes through the workflow.

## 5. Each build

Actions → App → Run workflow: the environment (`staging` or `live`), the stores, and whether to
send the Android listing's text. Or push a tag `app-v<mobile.app.version>` on `main` (live, both
stores). A person approves `app-record` (the build number), `app-upload` (the builds) and
`app-record` again (the record). The run:

1. checks it is on `main`, runs `cos app check` and `cos app build-info` (the build number: the
   highest recorded plus one, the same on both platforms);
2. builds Android on Linux and iOS on macOS, signs, and sends each to its testing track (Android:
   `internal`; iPhone: the store's testing track, by the platform's own upload);
3. records each build that went (`cos app record`) in the host's `core_app_build`.

A job that misses a secret fails at its first step with the names and how to set them.

## 6. Review and release

- A person submits the build for review in each store's console, with the listing from
  `apps/mobile/store/<locale>/` (the iPhone listing is entered there; the workflow does not send
  it), the privacy answers and the reviewer's sign-in. Store review access, a test member with a
  fixed code (stage 63 step 5), is not built yet: until it is, give the reviewer a test member a
  person made, with no real data.
- **The client says yes** to the release, recorded on the release's pull request or tag.
- A person on our side releases it to the public in each store's console. No command does, and
  nothing goes out on its own when a store approves it. A staging app is never listed publicly.

## 7. A new version

A pull request bumps `mobile.app.version` (and the release notes). After it merges, a tag
`app-v<version>` on `main` (or a manual run) builds it. A store id never changes: `cos app check`
and `cos app record` refuse one that differs from a recorded build's.
