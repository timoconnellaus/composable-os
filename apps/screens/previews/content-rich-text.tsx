import { RichText } from "../../../packs/content/blocks/content-rich-text/rich-text.tsx";
import { pictureUrl, starterBody } from "./data/content.ts";

export const width = 760;

export default function Preview() {
  return <RichText value={starterBody} mediaUrl={pictureUrl} />;
}
