// One post, for a site's /blog/<slug> page (stage 28): its title, date, cover and body, as the
// public reads it (`usePost`: the published version only, ADR 0442). An old address answers
// `redirect`: the page calls `onRedirect` with the address the post has now, so the site sends a
// 301 there. A preview link's token shows the working copy instead (`PostPreview`).
import type { ContentHooks, PublicPost } from "@composable-os/pack-content/client";
import { mediaPath, postDate } from "@composable-os/pack-content/client";
import { RichText } from "../content-rich-text/rich-text.tsx";

/** A post's article: shared by the page and the preview. */
export function PostArticle({
  post,
  mediaBase = "",
  mediaUrl = (id, width) => mediaPath(id, width, mediaBase),
  preview = false,
}: {
  post: PublicPost;
  /** Another origin for the pictures than this site's /api/media route. */
  mediaBase?: string;
  mediaUrl?: (id: string, width: number) => string;
  preview?: boolean;
}) {
  const v = post.values;
  return (
    <article className="mx-auto grid max-w-3xl gap-6" data-post={post.id}>
      {preview ? (
        <p role="status" className="rounded bg-muted p-2 text-sm">
          Preview: this is the draft, not what readers see.
        </p>
      ) : null}
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold">{v.title}</h1>
        {postDate(post) ? (
          <time dateTime={v.date ?? v.publishedAt ?? undefined} className="text-muted-foreground">
            {postDate(post)}
          </time>
        ) : null}
      </header>
      {v.cover ? (
        <img
          src={mediaUrl(v.cover.media, 1280)}
          alt={v.cover.alt}
          className="w-full rounded-lg object-cover"
          style={
            v.cover.focal
              ? { objectPosition: `${v.cover.focal.x * 100}% ${v.cover.focal.y * 100}%` }
              : undefined
          }
        />
      ) : null}
      <RichText value={v.body} mediaUrl={mediaUrl} />
    </article>
  );
}

export function PostPage({
  content,
  slug,
  onRedirect,
  mediaUrl,
  mediaBase,
}: {
  content: Pick<ContentHooks, "usePost">;
  slug: string;
  /** The post's address now, for an old one: send a 301 there. */
  onRedirect: (slug: string) => void;
  mediaUrl?: (id: string, width: number) => string;
  mediaBase?: string;
}) {
  const { data, isPending, error } = content.usePost(slug);
  if (isPending) return <p aria-busy="true">Loading…</p>;
  if (error || !data) return <p role="alert">This post is not here. It may have moved or ended.</p>;
  if (data.kind === "redirect") {
    onRedirect(data.slug);
    return <p>This post has moved.</p>;
  }
  return (
    <PostArticle
      post={data}
      {...(mediaUrl ? { mediaUrl } : {})}
      {...(mediaBase ? { mediaBase } : {})}
    />
  );
}

/** The working copy of a post, for whoever holds a preview link. */
export function PostPreview({
  content,
  slug,
  token,
  mediaUrl,
  mediaBase,
}: {
  content: Pick<ContentHooks, "usePreview">;
  slug: string;
  token: string;
  mediaUrl?: (id: string, width: number) => string;
  mediaBase?: string;
}) {
  const { data, isPending, error } = content.usePreview(slug, token);
  if (isPending) return <p aria-busy="true">Loading…</p>;
  if (error || !data)
    return <p role="alert">This preview link has ended or is not for this post.</p>;
  return (
    <PostArticle
      post={data}
      preview
      {...(mediaUrl ? { mediaUrl } : {})}
      {...(mediaBase ? { mediaBase } : {})}
    />
  );
}
