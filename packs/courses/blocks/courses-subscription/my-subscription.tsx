// A member's own course subscription on the studio's site (stage 32a), through My account's one
// subscriptions part (`web-account-subscriptions`, stage 48): its state in words, the next charge
// or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a
// payment that waits on them. The card and past invoices are My account's Payment method section,
// once for every subscription: this block has no card button. Every action is the host's operation
// (`subscription.*`), on the member's own subscription only; the host refuses what does not apply,
// and the record changes once the provider confirms. Web only: the app shows the subscription and
// does nothing to it.
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { formatMinor, subscriptionStatus } from "@composable-os/pack-courses/client";
import { MySubscriptions } from "../web-account-subscriptions/subscriptions.tsx";

export function MySubscription({
  courses,
  empty = "You have no course subscription.",
}: {
  courses: Pick<
    CoursesHooks,
    "useMySubscriptions" | "useCancelSubscription" | "useResumeSubscription"
  >;
  /** Kept for a page that still passes it: the card is My account's Payment method section. */
  returnUrl?: string;
  /** What to say when there is none; null says nothing (as a part of the Courses section). */
  empty?: string | null;
}) {
  return (
    <section className="grid gap-4" aria-label="My subscription">
      <MySubscriptions
        account={{
          useSubscriptions: courses.useMySubscriptions,
          useCancelSubscription: courses.useCancelSubscription,
          useResumeSubscription: courses.useResumeSubscription,
        }}
        label="Your course subscription"
        empty={empty}
        status={subscriptionStatus}
        words={{
          cancel: "Cancel subscription",
          resume: "Keep my subscription",
          confirmCancel: "Cancel? You keep every course until the period ends.",
          description: (sub) =>
            `${formatMinor(sub.amount, sub.currency)} a ${sub.interval} · every course`,
        }}
      />
    </section>
  );
}
