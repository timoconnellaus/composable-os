// A course's page on a studio's site (stage 42): its description, trailer and outline with lesson
// titles and minutes, the free previews, and either "buy" or "open". Whether the visitor holds the
// course, and its price, are the host's (`useCourse`); buying is the host's order and the
// provider's page (`useBuy`); a trailer plays with a token the host signs (`usePlayback`).
//
// What must be agreed to first (stage 44: the course's terms) is the host's answer too: when "Buy"
// is refused with it, the documents are shown inline (the web-agree block's step) and "Buy" is
// tried again (issue #292). A visitor's agreements travel in the buying call, held in memory until
// then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.
import {
  type AgreeInput,
  type AgreementsHooks,
  agreementRefusal,
  forgetAfter,
  purchaseErrorWords,
  type RefusedDocument,
  withAgreements,
} from "@composable-os/client";
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { COURSE, formatPrice, minutes } from "@composable-os/pack-courses/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";
import { useForgetOnLeave } from "../web-agree/agree.tsx";
import { GuestAgreementStep, MemberAgreementStep } from "../web-agree/agreement-step.tsx";

/** The agreements hooks the inline step uses: a member's (due, accept) and a visitor's (words). */
export type CourseAgreements = Pick<AgreementsHooks, "useDue" | "useAccept" | "useGuestVersions">;

export function CoursePage({
  courses,
  agreements,
  slug,
  returnUrl,
  signedIn,
  onOpenLesson,
}: {
  courses: Pick<CoursesHooks, "useCourse" | "useBuy" | "usePlayback">;
  /** For what must be agreed to first, shown inline. Without it, the refusal is only named. */
  agreements?: CourseAgreements;
  slug: string;
  /** Where the provider's page sends the buyer back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer buys as themselves; a guest gives their email. */
  signedIn: boolean;
  onOpenLesson: (courseId: string, lessonKey: string) => void;
}) {
  const { data: course, isPending, error } = courses.useCourse(slug);
  const trailer = courses.usePlayback(
    course?.trailer
      ? {
          media: course.trailer.media,
          record: { object: COURSE, id: course.id },
          field: "trailer",
        }
      : null,
  );
  const buy = courses.useBuy();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the host said must be agreed to first.
  const [due, setDue] = useState<RefusedDocument[] | null>(null);
  // A visitor's agreements: this component's state only, kept if the order does not start
  // (nothing typed twice), forgotten once it starts and when they leave the page.
  const [agreed, setAgreed] = useState<AgreeInput[] | null>(null);
  // A member's "a copy is on its way".
  const [said, setSaid] = useState<string | null>(null);
  useForgetOnLeave(() => setAgreed(null));
  if (isPending) return <p aria-busy="true">Loading the course…</p>;
  if (error || !course) return <p role="alert">This course is not here.</p>;

  async function onBuy(given: AgreeInput[] | null = agreed) {
    if (!course) return;
    setProblem(null);
    setBusy(true);
    try {
      const courseId = course.id;
      const outcome = await withAgreements((previous) =>
        forgetAfter(buy.start, {
          courseId,
          ...(signedIn ? {} : { email }),
          ...(!signedIn && given && previous?.kind !== "read_again" ? { agreements: given } : {}),
        }),
      );
      if (outcome.kind !== "done") setAgreed(null);
      if (outcome.kind === "due") {
        if (agreements) setDue(outcome.documents);
        else {
          setProblem(
            `Something must be agreed to first: ${outcome.documents.map((d) => d.title).join(", ")}.`,
          );
        }
        return;
      }
      if (outcome.kind === "minor_payer") {
        setProblem(outcome.message);
        return;
      }
      const order = outcome.value;
      // Recorded with the order: nothing of it is kept here any more.
      setAgreed(null);
      const checkout = await buy.checkout.mutateAsync({
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl,
      });
      window.location.assign(checkout.url);
    } catch (e) {
      const refusal = agreementRefusal(e);
      if (refusal) setAgreed(null);
      setProblem(
        purchaseErrorWords(e) ??
          (refusal
            ? refusal.message
            : e instanceof Error
              ? e.message
              : "We could not start your order"),
      );
    } finally {
      setBusy(false);
    }
  }

  if (due && agreements) {
    const back = () => setDue(null);
    return signedIn ? (
      <MemberAgreementStep
        agreements={agreements}
        documents={due}
        continueLabel="Agree and buy"
        onCancel={back}
        onAgreed={(copy) => {
          setDue(null);
          setSaid(copy);
          void onBuy(null);
        }}
      />
    ) : (
      <GuestAgreementStep
        agreements={agreements}
        documents={due}
        continueLabel="Agree and buy"
        onCancel={back}
        onAgreed={(given) => {
          setDue(null);
          setAgreed(given);
          void onBuy(given);
        }}
      />
    );
  }

  return (
    <article className="grid gap-6" aria-labelledby="course-title">
      <h1 id="course-title" className="text-3xl font-semibold">
        {course.title}
      </h1>
      {course.summary ? <p className="text-lg">{course.summary}</p> : null}
      {trailer.data ? (
        // biome-ignore lint/a11y/useMediaCaption: captions come in the stream's own manifest.
        <video
          controls
          playsInline
          src={trailer.data.hls}
          poster={trailer.data.poster}
          className="w-full rounded-lg"
        />
      ) : null}
      {course.holds ? (
        <p>
          <Button
            onClick={() => {
              const first = course.sections[0]?.lessons[0];
              if (first) onOpenLesson(course.id, first.key);
            }}
          >
            Open the course
          </Button>
        </p>
      ) : (
        <form
          className="grid max-w-sm gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onBuy();
          }}
        >
          {signedIn ? null : (
            <>
              <Label htmlFor="buyer-email">Your email</Label>
              <Input
                id="buyer-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </>
          )}
          <Button type="submit" disabled={busy}>
            {`Buy · ${formatPrice(course.price, course.currency)}`}
          </Button>
          {said ? <p role="status">{said}</p> : null}
          {agreed ? (
            <p className="text-sm">
              What you agreed to is kept for this order: press Buy to try again.
            </p>
          ) : null}
          {problem ? <p role="alert">{problem}</p> : null}
        </form>
      )}
      <ol className="grid gap-4" aria-label="Outline">
        {course.sections.map((section) => (
          <li key={section.key}>
            <h2 className="text-xl font-semibold">{section.title}</h2>
            <ul className="grid gap-1">
              {section.lessons.map((lesson) => (
                <li key={lesson.key} className="flex items-center justify-between gap-2">
                  <span>
                    {course.done.includes(lesson.key) ? "✓ " : ""}
                    {lesson.title}
                    {lesson.duration ? ` · ${minutes(lesson.duration)}` : ""}
                  </span>
                  {course.holds || lesson.preview ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onOpenLesson(course.id, lesson.key)}
                    >
                      {lesson.preview && !course.holds ? "Watch the preview" : "Open"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </article>
  );
}
