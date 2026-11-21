// The published posts, newest first, for a site's /blog page (stage 28): each with its cover,
// title, date and excerpt, and a link to it. What is published is the host's (`usePosts`).
import type { ContentHooks, PublicPost } from "@composable-os/pack-content/client";
import { mediaPath, plainText, postDate } from "@composable-os/pack-content/client";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

/** A post's summary: its excerpt, else the start of its body. */
function summary(post: PublicPost): string {
  if (post.values.excerpt) return post.values.excerpt;
  const words = plainText(post.values.body);
  return words.length > 200 ? `${words.slice(0, 197).trimEnd()}…` : words;
}

export function PostList({
  content,
  hrefOf,
  category,
  after,
  olderHref,
  mediaBase = "",
  mediaUrl = (id, width) => mediaPath(id, width, mediaBase),
}: {
  content: Pick<ContentHooks, "usePosts">;
  /** The page a post is read on: `(slug) => "/blog/" + slug`. */
  hrefOf: (slug: string) => string;
  /** Only posts of this category (its id). */
  category?: string;
  /** The page's cursor: what the previous page's "Older posts" link carried. */
  after?: string;
  /** The address of the next page, given its cursor: `(c) => "/blog?after=" + c`. */
  olderHref?: (cursor: string) => string;
  /** Another origin for the pictures than this site's /api/media route. */
  mediaBase?: string;
  mediaUrl?: (id: string, width: number) => string;
}) {
  const { data, isPending, error } = content.usePosts({
    limit: 20,
    ...(category ? { filter: { field: "category", op: "eq", value: category } } : {}),
    ...(after ? { cursor: after } : {}),
  });
  if (isPending) return <p aria-busy="true">Loading posts…</p>;
  if (error) return <p role="alert">We could not load the posts. Try again in a moment.</p>;
  if (!data?.items.length) return <p>Nothing has been posted yet.</p>;
  return (
    <div className="grid gap-6">
      <ul className="grid gap-4">
        {data.items.map((post) => (
          <li key={post.id}>
            <Card>
              {post.values.cover ? (
                <img
                  src={mediaUrl(post.values.cover.media, 640)}
                  alt={post.values.cover.alt}
                  className="w-full rounded-t-lg object-cover"
                />
              ) : null}
              <CardHeader>
                <CardTitle>
                  <a href={hrefOf(post.values.slug ?? "")} className="hover:underline">
                    {post.values.title}
                  </a>
                </CardTitle>
                {postDate(post) || post.values.byline ? (
                  <CardDescription>
                    {[postDate(post), post.values.byline].filter(Boolean).join(" · ")}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                <p>{summary(post)}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {data.nextCursor && olderHref ? (
        <Button variant="outline" asChild>
          <a href={olderHref(data.nextCursor)}>Older posts</a>
        </Button>
      ) : null}
    </div>
  );
}
