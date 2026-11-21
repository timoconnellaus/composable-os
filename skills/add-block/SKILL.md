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

1. **Find it.** `pnpm cos add <name>` with a name that does not exist lists the release's blocks.
   A block's `block.json` says its pack (or none for the base layer), its skin (`web` for the web
   app, `native` for the mobile app), the operations it calls and the blocks it depends on.
2. **Check it fits.** A pack's block needs that pack in `product.ts`'s `packs`. A web block needs
   a web app, a native block the mobile app. The operations it calls must be ones the generated
   client has (`<app>/src/client/customer.ts`, or `src/composable-os/` in an adopted repo).
3. **Copy it.** `pnpm cos add <name>`. Its files go to `<app>/src/blocks/<name>/`, the blocks it
   depends on with it, and `blocks.lock.json` records each block's version and files. Commit them.
4. **Restyle it** to the company's brand: change the copied files freely (colours, type, layout,
   wording). Keep its calls to operations as they are: a block holds no rules.
5. **Wire it** to a route in the app (a TanStack route file in the web app, a screen in the Expo
   app), passing it the typed client or the data it asks for.
6. **Later, upstream changes.** After `cos upgrade`, `pnpm cos diff <name>` shows what changed in
   the block between the version you copied and the release you are on, and which of your files
   you have edited. Nothing changes your copy: apply what you want by hand.

## The rules

- Copy blocks, do not import them from a package.
- A block never calculates a price, checks a capacity, checks a permission or decides what a
  customer may see. It calls an operation and shows the answer. The platform's block lint refuses
  a block that does.
- **When the platform lacks something** (a block, or an operation the block needs): stop that
  part, say exactly what the platform needs, and build the rest. Never fake it in the app.

## The check

The app's own type check (`pnpm -r typecheck`) passes with the block wired in, and `cos deploy`
runs it again before deploying.
