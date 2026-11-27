// Every piece of module-level state in the code the host's Workers load, with what it is and why it
// is safe on a host that serves many clients (stage 66 step 5, ADR 0617). Read by
// scripts/check-module-state.mjs, which fails on state that is not here and on an entry whose
// state is gone.
//
// Each entry is `"<file>#<name>": [decision, why]`. The decisions:
// - `client`: kept apart per client. Core's own use `clientState` (packages/core/src/client-scope.ts)
//   and do not appear here; these are keyed by something that is one client's (its environment,
//   its database, one call's write queue or context, a connection's object, a secret).
// - `independent`: holds nothing of any client's: code registered at load, constants worked out
//   once, the deployment's own values, a counter, a log line's dedupe.
// - `call`: lives for one request or call (an AsyncLocalStorage), or runs only in a browser.
//
// What the check cannot see, for reviewers: a container exported and changed from another file, an
// alias of a container (`const m = cache; m.set(…)`), and state made by a call at module level (a
// closure a factory returns, a registry object a function builds).
//
// Adding a cache? Key it by client first: in packages/core, `clientState(() => …)`; elsewhere a
// WeakMap keyed by the client's environment (on a single client, one slot, as `SINGLE_CLIENT`
// does in apps/app/src/server/operations.ts). Then list it here, saying what it is keyed by.

const BROWSER = "runs in the browser only: one person's page";
const PER_CALL = "keyed by one call's write queue or context, gone with the call";
const BY_ENV = "keyed by the environment object: on a many-client host each client's is its own";
const CODE = "code registered at load (the release's), no record or setting";
const ONCE = "worked out once from the code's own constants";
const LOG = "only quiets a repeated log line; holds no record";
const VENDOR_UI = "a gatekeeper's configurator page, run in the browser's frame for one connection";

export const MODULE_STATE = {
  // --- apps/app: the browser's -------------------------------------------------------------
  "apps/app/src/components/filter-builder/model.ts#nextId": ["call", BROWSER],
  "apps/app/src/components/integrations/configurator/configurator-form.tsx#specIds": [
    "call",
    BROWSER,
  ],
  "apps/app/src/components/integrations/configurator/configurator-form.tsx#nextSpecId": [
    "call",
    BROWSER,
  ],
  "apps/app/src/components/screens/screens.tsx#lastRefusalAsk": ["call", BROWSER],
  "apps/app/src/lib/scroll-memory.ts#offsets": ["call", BROWSER],
  "apps/app/src/routes/_app/settings/checklists.tsx#nextKey": ["call", BROWSER],
  "apps/app/src/routes/_app/settings/notes.tsx#nextRow": ["call", BROWSER],
  "apps/app/src/routes/blocks.tsx#linkedFormBlock": ["call", BROWSER],

  // --- apps/app: the server's --------------------------------------------------------------
  "apps/app/src/server/ai.ts#devVectors": [
    "client",
    "the in-memory stand-in (AI_FAKE_MODEL), one per client environment",
  ],
  "apps/app/src/server/ai.ts#drains": [
    "client",
    "the embedding drain, one per client's database (one slot on a single client)",
  ],
  "apps/app/src/server/assistant/agent.ts#AssistantAgent.options": [
    "independent",
    "the Agents SDK's options for the class, set in code",
  ],
  "apps/app/src/server/assistant/voice.ts#fakes": [
    "independent",
    "the speech stand-ins of local development and e2e (AI_FAKE_VOICE), never on a deployment",
  ],
  "apps/app/src/server/http/api.ts#surfaces": ["client", BY_ENV],
  "apps/app/src/server/http/bound.ts#noticeAt": [
    "client",
    "when each client environment's no-visitor notice was tried (one slot on a single client)",
  ],
  "apps/app/src/server/http/bound.ts#surfaces": ["client", BY_ENV],
  "apps/app/src/server/mcp/consent.ts#themeScriptHash": ["independent", ONCE],
  "apps/app/src/server/mcp/handler.ts#oauthEnvs": ["client", `${BY_ENV}, then by origin`],
  "apps/app/src/server/mcp/tools.ts#inputSchemas": [
    "independent",
    "a pure function of the operation object it is keyed by",
  ],
  "apps/app/src/server/mcp/tools.ts#describedSchemas": [
    "independent",
    "a pure function of the operation object it is keyed by",
  ],
  "apps/app/src/server/operations.ts#shippedInstalls": [
    "client",
    "the shipped extensions' install, once per client environment (one slot on a single client)",
  ],
  "apps/app/src/server/person-codes.ts#cached": [
    "client",
    "keyed by the auth secret the keys are derived from: a client's keys are only its secret's",
  ],
  "apps/app/src/server/request-env.ts#current": ["call", "the request's environment"],

  // --- apps/runner ---------------------------------------------------------------------------
  "apps/runner/src/extensions/shipped-list.ts#orgCache": [
    "client",
    "a client's own extensions, by client environment then content hash",
  ],

  // --- packs ---------------------------------------------------------------------------------
  "packs/forms/client/page.ts#scriptHash": ["independent", ONCE],
  "packs/ticketing/client/index.ts#digitsByCurrency": [
    "independent",
    "decimal places of a currency code, from Intl",
  ],

  // --- packages/auth -------------------------------------------------------------------------
  "packages/auth/src/better-auth.ts#isolateSecret": [
    "independent",
    "a random key for a host with no secret at all; a many-client host's client always has its derived CLIENT_ADDRESS_SECRET (ADR 0616), and its rate-limit keys carry the client",
  ],
  "packages/auth/src/better-auth.ts#hmacKeys": [
    "client",
    "keyed by the secret the key is imported from",
  ],
  "packages/auth/src/cloudflare-access.ts#remoteKeySets": [
    "independent",
    "Cloudflare Access's public keys, by the team's address",
  ],
  "packages/auth/src/index.ts#betterAuthCache": ["client", BY_ENV],
  "packages/auth/src/index.ts#staffCodes": ["client", BY_ENV],
  "packages/auth/src/index.ts#customerIdentityCache": ["client", BY_ENV],
  "packages/auth/src/index.ts#practitionerIdentityCache": ["client", BY_ENV],

  // --- packages/core -------------------------------------------------------------------------
  "packages/core/src/ai/roles.ts#warnedLegacy": ["independent", LOG],
  "packages/core/src/allowance/records.ts#recordUpdate": ["independent", CODE],
  "packages/core/src/allowance/records.ts#zones": ["client", PER_CALL],
  "packages/core/src/allowance/records.ts#pending": ["client", PER_CALL],
  "packages/core/src/assignment/index.ts#states": ["client", PER_CALL],
  "packages/core/src/assistant/fake.ts#callCounter": [
    "independent",
    "the fake model's counter of calls, for ids in tests",
  ],
  "packages/core/src/assistant/routines.ts#agentStarter": ["independent", CODE],
  "packages/core/src/automations/cron.ts#formatters": [
    "independent",
    "Intl formatters by time zone",
  ],
  "packages/core/src/automations/sources.ts#sources": ["independent", CODE],
  "packages/core/src/capacity/records.ts#simulated": ["client", PER_CALL],
  "packages/core/src/client-scope.ts#store": [
    "independent",
    "the deployment's AsyncLocalStorage of client scopes, given once at load",
  ],
  "packages/core/src/client-scope.ts#unscopedScope": [
    "independent",
    "what code outside every scope gets: refused on a many-client host",
  ],
  "packages/core/src/contact/suppression.ts#salts": [
    "client",
    "keyed by the database handle, one request's of one client",
  ],
  "packages/core/src/content/cache.ts#store": [
    "independent",
    "the runtime's cache object; each entry's key holds the random epoch of the client's own database (core_content_generation)",
  ],
  "packages/core/src/customers/portal.ts#unreadable": ["independent", LOG],
  "packages/core/src/devices/secret.ts#keys": ["client", "keyed by the secret it is imported from"],
  "packages/core/src/errors.ts#hasStock": [
    "independent",
    "a lookup function set at load; what it reads is the client's schema",
  ],
  "packages/core/src/extensions/tools.ts#cache": [
    "independent",
    "a pure function of its key, the whole declaration the operation is made from",
  ],
  "packages/core/src/fields/field-types.ts#zones": ["independent", "the runtime's time zone names"],
  "packages/core/src/ids.ts#lastTime": ["independent", "the id clock: time and randomness only"],
  "packages/core/src/ids.ts#lastRandom": ["independent", "the id clock: time and randomness only"],
  "packages/core/src/occupies/index.ts#batches": ["client", PER_CALL],
  "packages/core/src/operation.ts#HOST_TOOLS": ["independent", CODE],
  "packages/core/src/operation.ts#AUDITED_READS": ["independent", "operation names, from code"],
  "packages/core/src/operation.ts#PEOPLE_ONLY_AUDIT": ["independent", "operation names, from code"],
  "packages/core/src/operations/screens.ts#built": [
    "independent",
    "the release's own built screens, set once by the host",
  ],
  "packages/core/src/operations/screens.ts#unreadable": ["independent", LOG],
  "packages/core/src/orders/moves.ts#movingNow": ["client", PER_CALL],
  "packages/core/src/public-limits.ts#loggedAt": ["independent", LOG],
  "packages/core/src/rate-limit.ts#warned": ["independent", LOG],
  "packages/core/src/records/follows.ts#budgets": ["client", PER_CALL],
  "packages/core/src/records/lifecycle.ts#moveHooks": ["independent", CODE],
  "packages/core/src/records/lifecycle.ts#everyMoveHooks": ["independent", CODE],
  "packages/core/src/records/stream.ts#host": [
    "independent",
    "a single-client deployment's video host, from its own env; never set on a many-client host",
  ],
  "packages/core/src/records/stream.ts#resolve": [
    "independent",
    "how a many-client host finds the current client's video host (one per client, creator-checked)",
  ],
  "packages/core/src/recurring/bookkeeping.ts#batches": ["client", PER_CALL],
  "packages/core/src/recurring/index.ts#writer": ["independent", CODE],
  "packages/core/src/routine-mail/host-kinds.ts#declared": ["independent", CODE],
  "packages/core/src/staffing/changes.ts#gatheredBy": ["client", PER_CALL],
  "packages/core/src/staffing/index.ts#batches": ["client", PER_CALL],
  "packages/core/src/stock/low.ts#gatheredBy": ["client", PER_CALL],
  "packages/core/src/stock/moves.ts#openParents": ["client", PER_CALL],
  "packages/core/src/time/local.ts#offsetFormatters": [
    "independent",
    "Intl formatters by time zone",
  ],
  "packages/core/src/visibility/access.ts#kinds": ["independent", CODE],
  "packages/core/src/visibility/writes.ts#recordWriter": ["independent", CODE],
  "packages/core/src/visibility/writes.ts#coreWriters": ["independent", CODE],

  // --- packages/db ---------------------------------------------------------------------------
  "packages/db/src/client-bindings.ts#objectIdClient": [
    "client",
    "which client each Durable Object id was made for, checked on use",
  ],
  "packages/db/src/client-environment-build.ts#clientOfEnvironment": [
    "client",
    "which client each environment object is",
  ],
  "packages/db/src/client-environment-build.ts#environmentNameOf": [
    "client",
    "which of its environments (live, staging) each client environment object is",
  ],
  "packages/db/src/client-environment-build.ts#environmentOfView": [
    "client",
    "each object's view of its client's environment, by view (#520)",
  ],
  "packages/db/src/client-objects.ts#insideCall": [
    "call",
    "whether a call is already inside a checked one: one call's (#520)",
  ],
  "packages/db/src/client-objects.ts#enterScope": [
    "independent",
    "how an object's call enters its client's scope: the host Worker's, given once at load",
  ],
  "packages/db/src/client-environment.ts#directories": [
    "client",
    "the directory per host env; it keys every client's environment by client",
  ],
  "packages/db/src/handle.ts#databases": ["client", "the database each handle reaches, by handle"],
  "packages/db/src/registry-hpke.ts#SEALING_SUITE": [
    "independent",
    "the HPKE suite: algorithms, no key",
  ],
  "packages/db/src/registry-secrets.ts#importedRoot": [
    "independent",
    "the host's own root key as imported; what it derives is per client",
  ],

  // --- packages/product and packages/sdk -----------------------------------------------------
  "packages/product/src/index.ts#deployedLabel": [
    "independent",
    "the deployment's own product label (its COS_PRODUCT_LABEL var), what a client with no label of its own and code outside every client's scope read; a client's own label comes from its scope (clientLabel)",
  ],
  "packages/product/src/index.ts#clientLabel": [
    "independent",
    "code registered at load: reads the label of the scope the code runs in (core's AsyncLocalStorage), holds none itself",
  ],
  "packages/sdk/src/testing.ts#sequence": [
    "independent",
    "the SDK's test harness's id counter; never in a Worker",
  ],

  // --- gatekeepers: their Workers serve every client's connections --------------------------
  "packages/gatekeeper-email/src/email.ts#emailConfiguratorEnvs": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
  "packages/gatekeeper-google/src/configurator/drive-configurator-ui.tsx#access": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-google/src/configurator/drive-configurator-ui.tsx#listings": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-google/src/configurator/drive-configurator-ui.tsx#editAccess": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-google/src/configurator/drive-configurator-ui.tsx#flow": ["call", VENDOR_UI],
  "packages/gatekeeper-google/src/configurator/drive-configurator-ui.tsx#generation": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-google/src/google-api.ts#parsedMimeReconstructionErrors": [
    "client",
    "keyed by one parsed message object",
  ],
  "packages/gatekeeper-google/src/google-api.ts#parsedAttachmentMetadata": [
    "client",
    "keyed by one parsed message object",
  ],
  "packages/gatekeeper-google/src/google-configurators.ts#googleTokenGetters": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
  "packages/gatekeeper-google/src/google-configurators.ts#grantChecks": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
  "packages/gatekeeper-google/src/google-configurators.ts#calendarConfiguratorCaches": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
  "packages/gatekeeper-google/src/google-configurators.ts#bigQueryConfiguratorCaches": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
  "packages/gatekeeper-google/src/google.ts#googleDocTypesCode": [
    "independent",
    "type declarations from the bundle",
  ],
  "packages/gatekeeper-google/src/google.ts#driveAgentTypesCode": [
    "independent",
    "type declarations from the bundle",
  ],
  "packages/gatekeeper-google/src/google.ts#googleDriveTypesCode": [
    "independent",
    "type declarations from the bundle",
  ],
  "packages/gatekeeper-google/src/sheets-simulation.ts#LOG_VIEWS": [
    "client",
    "keyed by one simulated grid object",
  ],
  "packages/gatekeeper-google/src/sheets.ts#sheetsTypesCode": [
    "independent",
    "type declarations from the bundle",
  ],
  "packages/gatekeeper-google/src/slides.ts#slidesTypesCode": [
    "independent",
    "type declarations from the bundle",
  ],
  "packages/gatekeeper-kit/src/actions.ts#submissions": [
    "client",
    "keyed by one connection's journal object",
  ],
  "packages/gatekeeper-microsoft/src/calendar-time.ts#formatters": [
    "independent",
    "Intl formatters by time zone",
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#connection": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#asked": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#generation": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#rerender": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#calendarLists": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#colleagueNotices": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#colleague": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/calendar-configurator-ui.tsx#moreOpen": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#connection": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#asked": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#generation": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#rerender": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#folderLists": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#folderQuery": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#folderRevealed": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#shared": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#people": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#peopleTimer": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#names": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#conversations": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/outlook-configurator-ui.tsx#conversationTimer": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#connection": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#asked": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#generation": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#missing": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#rerender": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#picker": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/configurator/sharepoint-configurator-ui.tsx#announced": [
    "call",
    VENDOR_UI,
  ],
  "packages/gatekeeper-microsoft/src/content/zip.ts#crcTable": [
    "independent",
    "the CRC-32 table, worked out once",
  ],
  "packages/gatekeeper-microsoft/src/outlook-content.ts#tableKinds": [
    "client",
    "keyed by one parsed element of one message",
  ],
  "packages/gatekeeper-slack/src/slack-configurators.ts#apiByTarget": [
    "client",
    "keyed by the configurator object, one per connection's session",
  ],
};
