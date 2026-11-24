// One post, for the mobile app (stage 28): its title, date, cover and body as the public reads
// it (`usePost`: the published version only). An old address goes to the post's address now.
import type { ContentHooks } from "@composable-os/pack-content/client";
import { postDate } from "@composable-os/pack-content/client";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { RichTextView } from "../content-native-rich-text/rich-text-view.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

export function PostScreen({
  content,
  slug,
  openUrl,
  mediaUrl,
  onRedirect,
  width,
}: {
  content: Pick<ContentHooks, "usePost">;
  slug: string;
  openUrl: (url: string) => void;
  /** Absolute: `hostMediaUrl(hostUrl)`, the host's `/api/v1/media/<id>?w=<width>`. */
  mediaUrl: (id: string, width: number) => string;
  onRedirect: (slug: string) => void;
  /** The screen's width in device pixels, for the pictures. */
  width?: number;
}) {
  const { data, isPending, error } = content.usePost(slug);
  if (isPending) return <Text style={styles.muted}>Loading…</Text>;
  if (error || !data) {
    return (
      <Text accessibilityRole="alert">This post is not here. It may have moved or ended.</Text>
    );
  }
  if (data.kind === "redirect") {
    onRedirect(data.slug);
    return <Text style={styles.muted}>This post has moved.</Text>;
  }
  const v = data.values;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {v.title}
        </Text>
        {postDate(data) ? <Text style={styles.muted}>{postDate(data)}</Text> : null}
        {v.byline ? <Text style={styles.muted}>{v.byline}</Text> : null}
      </View>
      {v.cover ? (
        <Image
          source={{ uri: mediaUrl(v.cover.media, width ?? 960) }}
          accessibilityLabel={v.cover.alt}
          style={styles.cover}
          resizeMode="cover"
        />
      ) : null}
      <RichTextView
        value={v.body}
        openUrl={openUrl}
        mediaUrl={mediaUrl}
        {...(width ? { width } : {})}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: theme.space.md, gap: theme.space.md },
  header: { gap: theme.space.xs },
  title: { fontSize: theme.font.title, fontWeight: "700", color: theme.color.text },
  muted: { color: theme.color.muted, fontSize: theme.font.small },
  cover: { width: "100%", aspectRatio: 16 / 9, borderRadius: theme.radius },
});
