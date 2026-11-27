---
title: "The cos command"
description: "Every command of the cos CLI, as its own help gives them."
editUrl: false
---

`cos` is the one command for a company's own repository and for installing a product with no repository. This page is its `--help`, read from `packages/create-composable-os/src/main.ts`.

```text
cos: the Composable OS command. One command for a company's own repository and for
installing a product with no repository.
```

## A client repo (stage 24)

```text
  cos create <dir> [--label <name>] [--with-mobile] [--version x.y.z]
                                         a new client repo from the release's template (also
                                         `npm create composable-os <dir>`)
  cos init [--web <dir>] [--mobile <dir>] [--id <id>] [--label <name>] [--packs <list>]
           [--envs staging,live] [--yes]
                                         adopt the repo you are in: adds product.ts, skills/, each
                                         app's typed client and host module and the rules in
                                         AGENTS.md; shows a diff of every change to a file that
                                         exists and applies it with --yes. The id and label default
                                         to the folder's name; an adopted web app keeps its Worker
                                         and deploys itself (web.deploy "own"); --envs declares
                                         environments and binds HOST under the site's own ones
  cos deploy [--env <name>]              the host from the release in product.ts, with its packs and
                                         the org's own extensions (checked first), then the web app;
                                         with environments in product.ts, the one --env names
                                         (--rotate-customer-auth-secret: a new customer secret,
                                         which signs every customer out)
  cos upgrade [--version X.Y.Z]          in a client repo: move product.ts to a newer platform
                                         version, regenerate the client, replace skills/, report type
                                         errors; deploys nothing
  cos add <block>, cos diff <block> [--accept]
                                         copy a block from the release; show its upstream changes
                                         (--accept: record them as merged by hand)
                                         (cos add with no block lists them, with their skins)
  cos client generate                    in a client repo: each app's typed client, again (and
                                         the mobile app's brand.ts from product.ts)
  cos app check                          the mobile app before a store build: ids, icon, listing,
                                         nothing bought in the app, "Delete my account", no key
                                         file in the repo (stage 63, docs/app-publishing.md)
  cos app credentials [--check --for ios|android|record]
                                         the app workflow's secrets and how a person sets each;
                                         never a value (--check: fail on any one missing)
  cos app build-info [--env <name>] [--json]
                                         the next build number (the host's records) and the API
                                         version of the app's generated client
  cos app record [--env <name>] --platform ios,android --build <n> [--commit <sha>]
                                         record the builds a run sent to the testing tracks
  cos app upload --platform android [--env <name>] --file <app.aab> [--listing] [--draft]
                                         the Android build to the store's internal testing track;
                                         nothing is released to the public
  cos content import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes]
                                         load posts and their pictures into the host as you,
                                         signed in for the run (by code with --email, else in the
                                         browser); checks everything first and writes nothing on a
                                         problem; a re-run creates nothing twice; --publish
                                         publishes (or schedules) them with their own dates
                                         (docs/importing.md)
  cos courses import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes]
                     [--wait <minutes>]
                                         load courses, bundles, their videos (to Stream) and the
                                         students' access, completions and lesson progress from an
                                         old course platform, as you; checks first, uploads nothing
                                         twice on a re-run, keeps a student's own progress
                                         (docs/importing.md)
  cos subscriptions offers import <offers.csv> --host <url> --plan <object>[:<id>]
                     [--email <you>] [--dry-run] [--invite] [--reissue]
                                         continuation offers for people subscribed on another
                                         platform (email, paid-up date): each signs in and
                                         subscribes again, free until that date; people come
                                         first, none is created; --invite lets them sign in under
                                         any sign-up setting; --reissue gives an address staff
                                         withdrew a fresh offer (docs/importing.md)
  cos subscriptions offers report --host <url> [--status taken] [--out <file.csv>]
                                         who has taken their offer and when they are charged from,
                                         so you end exactly those old subscriptions
  cos programs import <folder> --host <url> [--email <you>] [--dry-run]
                                         load exercises, class types, programs in the pack's
                                         shorthand and past training (sessions and their sets), as
                                         you; checks everything first, a re-run makes nothing
                                         twice, an edit since is kept; what it brings in starts no
                                         automation and sends no message (docs/importing.md)
  cos rostering import <roster.csv> --host <url> [--email <you>] [--apply]
                                         duties and who works them (weekly patterns, one-off
                                         shifts); the host checks every date for someone on two
                                         shifts at once and names it; a dry run unless --apply;
                                         staff are invited first, never made (docs/importing.md)
```

## Installing a product with no client repo

```text
  cos install [options]                  install, or repair an existing install (idempotent)
  cos upgrade [--version X.Y.Z]          update to a newer release (preflight, bookmark, migrate,
                                         switch all Workers, smoke check; rolls back on failure)
  cos rollback                           redeploy the previous release and restore its bookmark
  cos status                             installed version, channel, URL and available releases
  cos uninstall                          delete the Workers, database, bucket and namespace (asks)
  cos ext check <dir> | test <dir>       in a checkout of the repository: check an extension with
                                         the checks the host runs, and run its tests
  cos client generate --out <dir>        in a checkout: write a product's typed client (customer.ts
                                         and staff.ts) from its registry; see cos client --help
```

## A host of many clients (stage 66; docs/deploying.md "A host of many clients")

```text
  cos fleet keys --env <live|staging> --out <file>
                                         the deployment's keys, written only to <file> (mode
                                         0600, refused inside a git working tree), never printed
  cos fleet install --env <e> --keys-file <f> --callback-hostname <h> --domain <d>
                    [--location <hint>] [--ai on|off] [--zone z] [--attach custom-domains|wildcard]
                                         the host, its registry, cos-client-db, the operator's
                                         Worker and cos-front, with every binding a fleet needs
                                         (--location and --ai at the first install only); learns
                                         the domain's zone and attaches the callback hostname
                                         and the CNAME target of clients' own domains
  cos fleet upgrade --env <e> --keys-file <f> [--version x.y.z] [--dry-run] [--yes]
                                         every client paused, bookmarked and migrated, the Workers
                                         uploaded once, smoke checked, resumed; a client whose
                                         migration fails is restored and nothing is uploaded; live
                                         only after staging (--skip-staging, deliberately)
  cos client add <id> [--env e] [--tier t] [--location oc] [--setting NAME=VALUE]… [--dry-run]
                                         a client: its registry rows, its database made and
                                         migrated, its staff hostname attached (a desk one with
                                         --desk; a web one, on its own domain and unverified,
                                         with --web-hostname); no upload
  cos client hostname add|verify|remove <id> <hostname>, cos client hostname list <id>
                                         a client's own web domain: added unverified with the
                                         DNS records it needs, verified once Cloudflare reports
                                         it active, then served by cos-front
  cos client pause|resume <id>, cos client list
  cos client secret set|remove <id> <NAME> [--value-file f]
                                         a client's given secret, sealed (this command cannot
                                         read one back)
  cos client export <id> [--out <dir>] [--leaving]
                                         its database, files (and with --out its secrets) for a
                                         move or a leaving client; kept 90 days in the host
  cos client import <id> --from <dir>    an export brought in as a new, imported client
  cos client remove <id>                 exported (kept 90 days), then erased; its id is never
                                         used again
  cos client sender add|verify|unverify|remove <id> <domain>
                                         a client's sender domains (added unverified; verify is
                                         your confirmation it is onboarded to Email Sending)
  Each asks for the client's id before removing or overwriting (or --yes); a re-run after a
  failure carries on where it stopped.
```

## Options

```text
  --token <t>            Cloudflare API token (or CLOUDFLARE_API_TOKEN). Needs, on the account:
                         Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV
                         Storage Edit, Queues Edit, Vectorize Edit, Account Settings Read; with AI
                         on, AI Gateway Edit, Account API Tokens Edit (to generate the gateway's
                         token) and Secrets Store Edit (for --provider-key); and for a custom
                         hostname, Zone Read + Workers Routes Edit on that zone.
  --account <id>         account id (or CLOUDFLARE_ACCOUNT_ID); asked when the token sees several
  --version <x.y.z>      release to install or upgrade to (default: newest on the channel)
  --channel <c>          stable (default) or beta
  --hostname <h>         "workers.dev" (default) or a hostname on one of your zones
  --zone <name>          the zone of a custom hostname (default: inferred from it)
  --identity <i>         better-auth (default) or cloudflare-access
  --location <hint>      a location hint for the D1 database and R2 buckets a first install
                         creates: none (default), or wnam, enam, weur, eeur, apac, oc
                         (oc is Oceania). A preference Cloudflare follows where it can, not a
                         guarantee; KV, queues and Vectorize take none. An existing install is
                         never moved (docs/deploying.md "Where data is stored")
  --gatekeepers <list>   optional gatekeeper Workers to install, e.g. google,email-send
  --ai <on|off>          in-app AI: Workers AI and the demo-records Vectorize index (default on,
                         or COS_AI). Off: AI features say "AI is not configured". Upgrades keep
                         the choice; re-run install with --ai to change it
  --ai-gateway <id|off>  AI Gateway every model call goes through (default: one named after the
                         install, e.g. crm, created with logging and authentication on and its
                         token, with AI Gateway Run and Workers AI Read, stored as
                         AI_GATEWAY_TOKEN). Workers AI then goes through it over REST with
                         prompt and response logging off. off: call Workers AI directly over
                         the binding
  --provider-key P=KEY   store a provider key in the gateway as BYOK (repeatable), e.g.
                         deepseek=… or openai=… (a custom provider by its slug; typesafe=… is
                         the judge's key, Jev, and sets JUDGE_BYOK). Never logged.
                         Keys can also be added later in Settings → AI
  --model-roles <m>      this deployment's model roles (the AI_MODEL_ROLES layer): a preset
                         (deepseek-flash), a JSON file, inline JSON, or
                         default (the shipped Workers AI roles). Kept by upgrades; Settings → AI
                         overrides still win
  --ai-admin-token <t>   Settings → AI's token (or COS_AI_ADMIN_TOKEN), stored on demo-app as
                         CLOUDFLARE_API_TOKEN; permissions in docs/deploying.md "In-app AI"
  --secret NAME=VALUE    a secret to set (repeatable); WORKER:NAME=VALUE for a gatekeeper's
  --update-token <t>     store a scoped token so Settings → Updates can update in place
  --store-update-token   store --token itself for one-click updates
  --product <id>         the product to install (default crm; one of crm)
  --product-file <f>     instead, the staging check's throwaway product, defined in a JSON file
                         (id cosstg-…, every name starting with it), for a release built for it
  --repo <owner/repo>    where releases come from (default: the product's own repository)
  --no-gh                skip `gh attestation verify` even if gh is installed
  --require-gh           fail unless `gh attestation verify` passes (full Sigstore check)
  --wait                 after install, wait until /api/health answers
  --import <dir>         a client's export (cos client export --out) installed as this new
                         deployment: its database, files and secrets; staff and customers stay
                         signed in, and its search index is rebuilt (stage 66)
  --bundle-dir <dir>     use composable-os-<product>-<version>.tar.gz and SHA256SUMS from <dir> instead of downloading
                         (still verified against its build attestation)
  --yes                  don't ask; fail on anything that would need an answer
  -h, --help

Nothing is sent anywhere except the Cloudflare API and GitHub Releases. No telemetry.
```
