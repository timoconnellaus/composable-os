import { ScrollView } from "react-native";
import { RichTextView } from "../../../packs/content/blocks/content-native-rich-text/rich-text-view.tsx";
import { pictureUrl, starterBody } from "./data/content.ts";

export default function Preview() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <RichTextView
        value={starterBody}
        openUrl={() => undefined}
        mediaUrl={pictureUrl}
        width={358}
      />
    </ScrollView>
  );
}
