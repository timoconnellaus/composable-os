// My shifts with each duty shift's checklist under it (stage 45 step 4b): the my-shifts block with
// `ShiftChecklist` in its `shiftExtra` slot, as an app that shows them together mounts it.
import type { RosteringHooks } from "@composable-os/pack-rostering/client";
import type { MyHoursHooks } from "../rostering-my-shifts/my-hours.tsx";
import { MyShifts } from "../rostering-my-shifts/my-shifts.tsx";
import { type ChecklistHooks, ShiftChecklist } from "./checklist.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useMine" | "useOffers" | "useOffer" | "useWithdraw"> &
  ChecklistHooks &
  MyHoursHooks;

export function MyShiftsWithChecklist({
  rostering,
  from,
  days,
  locale = "en-AU",
}: {
  rostering: Hooks;
  from?: string;
  days?: number;
  locale?: string;
}) {
  return (
    <MyShifts
      rostering={rostering}
      {...(from ? { from } : {})}
      {...(days ? { days } : {})}
      locale={locale}
      shiftExtra={(shift) => <ShiftChecklist rostering={rostering} shift={shift} locale={locale} />}
    />
  );
}
