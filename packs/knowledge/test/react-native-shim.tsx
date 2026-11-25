// (Content's own, packs/content/test/react-native-shim.tsx, with the base layer's field and button
// parts beside it.)
// React Native's components as plain elements, for drawing the native blocks in a test: each
// renders `<rn-<name>>` with its testID, accessibility role and label, and an image's address.
// What a phone draws is React Native's; what this checks is which elements the block makes from
// a document, and what they say. Styles and handlers are dropped.
import { createElement, type ReactNode, type Ref } from "react";

type Props = {
  testID?: string;
  nativeID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  source?: { uri?: string };
  children?: ReactNode;
  [key: string]: unknown;
};

function Host({ name, props }: { name: string; props: Props }) {
  const { testID, nativeID, accessibilityRole, accessibilityLabel, source, children } = props;
  return createElement(
    `rn-${name}`,
    {
      ...(testID ? { "data-testid": testID } : {}),
      ...(nativeID ? { "data-native-id": nativeID } : {}),
      ...(accessibilityRole ? { "data-role": accessibilityRole } : {}),
      ...(accessibilityLabel ? { "data-label": accessibilityLabel } : {}),
      ...(source?.uri ? { "data-src": source.uri } : {}),
    },
    children,
  );
}

export const View = (props: Props) => <Host name="view" props={props} />;
export const Text = (props: Props) => <Host name="text" props={props} />;
export const Image = (props: Props) => <Host name="image" props={props} />;
export const Pressable = (props: Props) => <Host name="pressable" props={props} />;
/** A scroll view, with the handle the readers scroll to a section's heading with. */
export const ScrollView = (
  props: Props & { ref?: Ref<{ scrollTo(to: { y: number; animated?: boolean }): void }> },
) => <Host name="scroll" props={props} />;
export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  hairlineWidth: 1,
};
export const Linking = { openURL: async (_url: string) => {} };
// The native base layer's own parts the Knowledge blocks draw with (its field and button).
export const TextInput = (props: Props) => <Host name="input" props={props} />;
export type TextInputProps = Props;
export const ActivityIndicator = (props: Props) => <Host name="spinner" props={props} />;
export const SafeAreaView = (props: Props) => <Host name="safe" props={props} />;
