---
name: add-block
description: Add a block (a ready-made screen or part of one, for a pack or the base layer, in a web or native skin) to a client app on Composable OS - find it, copy it with cos add, restyle it to the company's brand, wire it to a route, and later see upstream changes with cos diff. Use when asked to add a sign-in screen, a list, a form or another standard screen to a company's web or mobile app built on Composable OS.
---

# Add a block

Describes extension contract version 1.

## When to use it

A client app needs a screen the platform already has as a block: sign-in, the base layer's
buttons, fields, lists, sheets, or a pack's screens. Blocks ship inside the platform release that
`product.ts` names, under the MIT licence; once copied, the files belong to the company.

## The steps

1. **Find it.** `pnpm cos add` with no name lists the release's blocks, one a line: its skin
   (`web` for the web app, `native` for the mobile app), its pack or `base`, the operations it
   calls and the blocks it brings with it.
2. **Check it fits.**
   - A pack's block needs that pack in `product.ts`'s `packs`.
   - A web block needs a React web app (the template's TanStack Start app); it does not fit a site
     in another framework. A native block needs the mobile app.
   - The operations it calls must be in the app's generated client
     (`<app>/src/client/customer.ts`, or `src/composable-os/` in an adopted repo). The sign-in
     blocks call no operation: `web-sign-in` posts to the web app's `/auth/*` routes, which its
     host module serves; `native-sign-in` takes `actions` with `requestCode` and `signIn`, which
     the mobile app's `hostSession` has.
3. **Copy it.** `pnpm cos add <name>`. Its files go to `<app>/src/blocks/<name>/`, with the blocks
   it depends on, and `blocks.lock.json` records each block's version and files. If it prints a
   `pnpm add ...` line, run it in the app: those are the packages the block's files import. Commit
   the files (`cos create` made the repo a git repository; in an adopted repo, use its own).
4. **Restyle it** to the company's brand. The web blocks use Tailwind v4 classes on the tokens in
   the template's `apps/web/src/styles.css` (`--primary`, `--primary-foreground`, `--destructive`,
   `--input`, `--ring`, `--accent`, `--muted-foreground`, `--background`, `--foreground`, ...):
   brand the app by changing those values. The native blocks take their look from
   `native-base/theme.ts`. Change the copied files freely (layout, wording); keep their calls to
   operations as they are. With no brand given, leave the defaults.
5. **Wire it** to a route. In the template web app, replace the body of the route file, for
   example `apps/web/src/routes/sign-in.tsx`:
   `<SignInForm onSignedIn={() => window.location.assign("/account")} />`. In the Expo app, render
   it from the screen the app's navigation uses (`App.tsx` in the template; an `app/` route file
   with expo-router): `<SignInScreen actions={session} onSignedIn={...} />`.
6. **Later, upstream changes.** After `cos upgrade`, `pnpm cos diff <name>` says which of your
   copied files you edited and shows what changed in the block between the version you copied and
   the release you are on. Nothing changes your copy: apply what you want by hand.

## The rules

- Copy blocks, do not import them from a package.
- A block never calculates a price, checks a capacity, checks a permission or decides what a
  customer may see. It calls an operation and shows the answer. The platform's block lint refuses
  a block that does.
- **When the platform lacks something** (a block, or an operation the block needs): stop that
  part, say exactly what the platform needs, and build the rest. Never fake it in the app.

## The check

`pnpm typecheck` at the root (each app's own `typecheck`) passes with the block wired in, and
`cos deploy` checks the types again before deploying.
