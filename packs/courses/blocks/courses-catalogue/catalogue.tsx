// The course catalogue for a studio's site (stage 42): courses by theme and level, and bundles,
// with their prices. What is published and what it costs are the host's (`useCatalogue`); this
// lays them out.
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { formatPrice, mediaPath } from "@composable-os/pack-courses/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

const LEVELS = { 1: "Beginner", 2: "Intermediate", 3: "Advanced" } as const;

export function CourseCatalogue({
  courses,
  onOpenCourse,
  onOpenBundle,
}: {
  courses: Pick<CoursesHooks, "useCatalogue">;
  onOpenCourse: (slug: string) => void;
  onOpenBundle?: (slug: string) => void;
}) {
  const [theme, setTheme] = useState<string | undefined>(undefined);
  const { data, isPending, error } = courses.useCatalogue(theme ? { theme } : {});
  if (isPending) return <p aria-busy="true">Loading courses…</p>;
  if (error || !data) return <p role="alert">We could not load the courses. Try again soon.</p>;
  return (
    <section className="grid gap-6" aria-label="Courses">
      {data.themes.length ? (
        <nav className="flex flex-wrap gap-2" aria-label="Themes">
          <Button
            variant={theme ? "outline" : "default"}
            size="sm"
            onClick={() => setTheme(undefined)}
          >
            All
          </Button>
          {data.themes.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={theme === t.id ? "default" : "outline"}
              onClick={() => setTheme(t.id)}
            >
              {t.name}
            </Button>
          ))}
        </nav>
      ) : null}
      {data.courses.length ? null : <p>No courses yet.</p>}
      <ul className="grid gap-4 sm:grid-cols-2">
        {data.courses.map((course) => (
          <li key={course.id}>
            <Card>
              {course.cover ? (
                <img
                  src={mediaPath(course.cover.media, 640)}
                  alt=""
                  className="w-full rounded-t-lg"
                />
              ) : null}
              <CardHeader>
                <CardTitle>{course.title}</CardTitle>
                <CardDescription>
                  {[
                    course.level ? LEVELS[course.level as 1 | 2 | 3] : null,
                    `${course.lessons} lessons`,
                    formatPrice(course.price, data.currency),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {course.summary ? <p>{course.summary}</p> : null}
                <Button onClick={() => course.slug && onOpenCourse(course.slug)}>
                  See the course
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {data.bundles.length ? (
        <section aria-label="Bundles" className="grid gap-4">
          <h2 className="text-xl font-semibold">Bundles</h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {data.bundles.map((bundle) => (
              <li key={bundle.id}>
                <Card>
                  <CardHeader>
                    <CardTitle>{bundle.title}</CardTitle>
                    <CardDescription>
                      {`${bundle.courses.length} courses · ${formatPrice(bundle.price, data.currency)}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {bundle.summary ? <p>{bundle.summary}</p> : null}
                    {onOpenBundle && bundle.slug ? (
                      <Button variant="outline" onClick={() => onOpenBundle(bundle.slug as string)}>
                        See the bundle
                      </Button>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
