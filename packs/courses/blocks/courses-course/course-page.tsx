// A course's page on a studio's site (stage 42): its description, trailer and outline with lesson
// titles and minutes, the free previews, and either "buy" or "open". Whether the visitor holds the
// course, and its price, are the host's (`useCourse`); buying is the host's order and the
// provider's page (`useBuy`); a trailer plays with a token the host signs (`usePlayback`).
import { agreementBlockedWords } from "@composable-os/client";
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { formatPrice, minutes } from "@composable-os/pack-courses/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

export function CoursePage({
  courses,
  slug,
  returnUrl,
  signedIn,
  onOpenLesson,
}: {
  courses: Pick<CoursesHooks, "useCourse" | "useBuy" | "usePlayback">;
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
          record: { object: "courses.course", id: course.id },
          field: "trailer",
        }
      : null,
  );
  const buy = courses.useBuy();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (isPending) return <p aria-busy="true">Loading the course…</p>;
  if (error || !course) return <p role="alert">This course is not here.</p>;

  async function onBuy() {
    if (!course) return;
    setProblem(null);
    try {
      const order = await buy.start.mutateAsync({
        courseId: course.id,
        ...(signedIn ? {} : { email }),
      });
      const checkout = await buy.checkout.mutateAsync({
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl,
      });
      window.location.assign(checkout.url);
    } catch (e) {
      // Something must be agreed to first (stage 44): no agreement step here yet.
      setProblem(
        agreementBlockedWords(e) ??
          (e instanceof Error ? e.message : "We could not start your order"),
      );
    }
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
          <Button type="submit" disabled={buy.start.isPending || buy.checkout.isPending}>
            {`Buy · ${formatPrice(course.price, course.currency)}`}
          </Button>
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
