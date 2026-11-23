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
   - A web block needs React: the template's TanStack Start app, or **an Astro site with React
     islands**. In the browser it calls the host through the web app's `operationRoute` (the
     host module), so add each operation the block calls to that route's `allow` list. A site with
     no React at all does not fit. A native block needs the mobile app.
   - The operations it calls must be in the app's generated client
     (`<app>/src/client/customer.ts`, or `src/composable-os/` in an adopted repo); a staff block
     (the door scanner) calls a role client (`src/client/roles/<pack>.<role>.ts`, from
     `mobile.roles` in `product.ts`), never the staff client. The sign-in
     blocks call no operation: `web-sign-in` posts to the web app's `/auth/*` routes, which its
     host module serves; `native-sign-in` takes `actions` with `requestCode` and `signIn`, which
     the mobile app's `hostSession` has.
3. **Copy it.** `pnpm cos add <name>`. Its files go to `<app>/src/blocks/<name>/`, with the blocks
   it depends on, and `blocks.lock.json` records each block's version and files. If it prints an
   install line, run it: those are the packages the block's files import, the platform's at the
   release's version, with the command that fits the app (`npx expo install` in an Expo app, else
   the package manager its lockfile names). Commit
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
   A pack's block (Ticketing's `ticketing-*`, Programs' `programs-*`) takes the pack's hooks as a
   prop named for the pack: make them once with
   `createTicketingHooks({ useQuery, useMutation, useState }, api)` from
   `@composable-os/pack-ticketing/client` (Programs: `createProgramsHooks({ useQuery,
   useMutation, useState, useEffect }, api)` from `@composable-os/pack-programs/client`, whose
   builder saves itself and so needs `useEffect`; Content: `createContentHooks({ useQuery,
   useMutation }, api)` from `@composable-os/pack-content/client`) and pass them down. The
   agreement blocks (`web-agree`, `web-agreements-due`, `web-my-agreements` and their `native-*`
   twins) take `agreements`: `createAgreementsHooks({ useQuery, useMutation }, api)` from
   `@composable-os/client` itself. Pass the same `agreements` to Bookings' and Memberships'
   blocks that buy or book, so what must be agreed to first shows inline; in the web app allow
   the operations their block.json lists (`agreement.guestVersions` among them, for a visitor),
   and the template's `agreementPdfRoute` serves a person's signed PDF on the app's hostname.
   Rostering's blocks (`rostering-*`) take `rostering`: `createRosteringHooks({ useQuery,
   useMutation }, api)` from `@composable-os/pack-rostering/client`. They are staff screens: in
   the app, `api` is a role client, `rostering.team`'s for someone rostered with no other access,
   or a coach's generated with the grant (`mobile.roles: [{ role: "bookings.coach", grants:
   ["rostering:roster"] }]` in `product.ts`, then `cos client generate`); on the web they need a
   staff client, which a client web app does not have (its binding never serves staff). Each asks
   the host who is reading first and shows the rosterers' and pay screens only to who may see
   them. Content's
   rich text blocks (`content-rich-text`, `content-native-rich-text`) take the document itself
   and find pictures by themselves on the web: the template's `src/host.ts` has `mediaRoute`, which
   `src/server.ts` calls, forwarding `GET /api/media/<id>?w=` to the host over the binding (in an
   adopted site, call `mediaRoute(request, env)` from the site's own Worker before its pages; pass
   `mediaBase` for another origin). In the app, pass `mediaUrl={mediaUrlFor({ hostUrl })}` from the
   mobile template's `src/host.ts`: the host's `/api/v1/media/<id>`, and the native one an `openUrl` (React Native's `Linking.openURL`). `api` is the client the
   screen's user holds: the customer client on a customer's screen, the role client
   (`staff.client(createTicketingDoorClient)`) on the door scanner. The hooks returned are only
   those that client can back, and the block's prop names the hooks it calls
   (`Pick<TicketingHooks, "useCheckIn">`): if it does not type-check, the screen needs an operation
   its user's client does not hold. Do not cast; use the right client, or say what the platform
   needs (a role that holds it). Add that package (the block's
   `packages` say so) at the release's version. A native block that needs the device (a camera,
   a QR code, the screen's brightness, haptics) takes what it needs as a prop with a small type
   (`Scanner`, `Qr`, `brightness`, `haptics`, Programs' `onRestDone`), so pass the app's own
   (for example `expo-camera`, `react-native-qrcode-svg`, `expo-brightness`, `expo-haptics`).
   To try a pack's web block before copying it, in the platform's own repository run `pnpm dev`
   and open
   `/blocks?block=<name>&component=<export>&props=<json>`: it mounts the block where it sits, in
   development only, as whoever is signed in.
6. **Later, upstream changes.** After `cos upgrade`, `pnpm cos diff <name>` says which of your
   copied files you edited and shows what changed in the block between the version you copied and
   the release you are on. Nothing changes your copy: apply what you want by hand. When you have,
   `pnpm cos diff <name> --accept` shows the changes once more and records the block as merged up
   to the version the repo is on (in `blocks.lock.json`), so the next `cos diff` shows only what
   changes after it. It refuses `--version` of another release: upgrade first. Commit the lock.

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
