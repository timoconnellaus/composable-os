# The org's own extensions

One folder per extension, `extensions/<id>/`, written against `@composable-os/sdk` the way the
`write-extension` skill says. `cos deploy` checks every one with `cos ext check` first and stops,
with nothing changed, if any fails; then it installs them on the host as shipped extensions of
this product, with no approval inside the deployment.
