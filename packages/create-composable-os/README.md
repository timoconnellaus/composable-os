# create-composable-os

Install a Composable OS product (github.com/timoconnellaus/composable-os) into your own Cloudflare
account, then upgrade and roll it back. `--product` chooses it; the default, `crm`, is the CRM.
It downloads a release from GitHub Releases, verifies its sha256 and its GitHub build attestation, and talks to the Cloudflare API with your token. No wrangler, no service
of ours, no telemetry.

Not published to npm yet: build it from a checkout (`pnpm --filter create-composable-os build`) and run
`node packages/create-composable-os/dist/cli.js` wherever this says `npx create-composable-os`.

```sh
npx create-composable-os                  # install (or repair an install)
npx create-composable-os upgrade          # update to the newest release on your channel
npx create-composable-os rollback         # undo the last update (redeploy + restore the database bookmark)
npx create-composable-os status
npx create-composable-os --help           # every option, and the API token permissions
```

The token needs, on the account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV
Storage Edit, Queues Edit, Vectorize Edit and Account Settings Read; with in-app AI (the default)
also AI Gateway Edit and Account API Tokens Edit (the install creates an AI Gateway and its token),
plus Secrets Store Edit for `--provider-key`; for a custom hostname also Zone Read and Workers
Routes Edit on its zone. The CLI never prints secret values.

Full guide: [docs/deploying.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/deploying.md).
