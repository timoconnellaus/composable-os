# apps/screens

Every block drawn with dummy data, for the pictures on the docs site
([apps/docs](../docs/README.md)): each block's reference page shows its picture, and each pack's
and capability's Screens page shows its blocks' pictures.

```sh
pnpm --filter @composable-os/screens dev                 # http://localhost:4323, every preview
pnpm --filter @composable-os/screens shoot               # draw every picture that is stale
pnpm --filter @composable-os/screens shoot <block> …     # draw these blocks' pictures
pnpm --filter @composable-os/screens check               # fail on a missing or stale picture
pnpm --filter @composable-os/screens typecheck           # the previews against the contract
```

## How a block is drawn

A block is mounted as a client app mounts it, with its pack's real hooks factory, over a fake
client (`src/fake.ts`) that answers each operation from the block's preview. The answers are typed
by each operation's output (the pack's `*Operations` type), so a contract change that the dummy
data no longer fits fails `typecheck`.

- A web block is drawn in the client template's look (`templates/client/apps/web/src/styles.css`),
  at 1024 pixels wide unless its preview says otherwise.
- A native block is drawn through react-native-web on a phone's screen (390 × 844, at 2×).
- The clock is fixed to `NOW` on `TODAY` (Monday 2 March 2026, 09:30) in `TIME_ZONE`
  (`src/fake.ts`). `at("18:00")` is an instant that day, `dayAfter(n)` a date after it.
- A picture on the media route (`/api/media/<id>` on the site, `/api/v1/media/<id>` on the host)
  is drawn as a placeholder whose colour comes from its id: give covers and pictures any id.
- A query the block makes that its preview does not answer, or a block that throws, fails the
  picture, naming it: a picture never shows a loading state or an error by accident.

The pictures are written to `apps/docs/public/screens/<block>.png`, with `screens.json` beside them:
each picture's size and the fingerprint of what it was drawn from (the block and the blocks it
depends on, its pack's `client/`, the harness, its preview and the dummy data it imports). The docs
site's check fails when a block has no preview or its picture is stale, so a PR that changes a block
runs `shoot` and commits the pictures it writes.

## Writing a preview

One file per block: `previews/<block>.tsx`, named exactly as the block. It imports the block's
component from where it sits and default-exports a component that draws it:

```tsx
import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { ClassList } from "../../../packs/bookings/blocks/bookings-class-list/class-list.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { hiitRoster } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, { "x.bookings.roster": hiitRoster }),
);

export const width = 720; // optional: a web block's picture width

export default function Preview() {
  return <ClassList bookings={bookings} classId="cls_1" />;
}
```

- **Answers**: each is the operation's output, or a function of its input returning one. Answer
  every query the block makes as it first draws; mutations need an answer only when one is drawn.
- **Shared dummy data** goes in `previews/data/<pack>.ts` (typed with the pack's `*Operations`), so
  a pack's blocks show the same people and classes. A picture's fingerprint covers only the data
  files its preview imports.
- **Which state**: show the block in use, with enough rows to read as real (four to eight), a mix
  of states where it has them, and no empty lists. Choose the part of a block worth seeing: a
  native screen that opens on a list can `export const click = "Morning HIIT"` (or a list,
  clicked in order; `{ role: "button", name: "Open" }` clicks by role and name) to open a row before the picture is taken, and
  `export const fill = [["Name", "Jordan Lee"]]` types into fields (by label or placeholder) after
  the clicks.
- **Names**: plain made-up people, places and businesses. Never a client's name or details (the
  docs site's rule). Prices in a currency the operation returns are fine: they come from dummy
  data, not hand-written text.
- **Rules stay the host's**: dummy data is what an operation could answer. Never change a block to
  make its picture look better; a block that cannot be drawn without a change is a finding.
