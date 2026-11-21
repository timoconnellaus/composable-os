// React Native's components as plain elements, for drawing the native blocks in a test: each
// renders `<rn-<name>>` with its testID, accessibility role and label, and an image's address.
// What a phone draws is React Native's; what this checks is which elements the block makes from
// a document, and what they say. Styles and handlers are dropped.
import { createElement, type ReactNode } from "react";

type Props = {
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  source?: { uri?: string };
  children?: ReactNode;
  [key: string]: unknown;
};

function Host({ name, props }: { name: string; props: Props }) {
  const { testID, accessibilityRole, accessibilityLabel, source, children } = props;
  return createElement(
    `rn-${name}`,
    {
      ...(testID ? { "data-testid": testID } : {}),
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
export const ScrollView = (props: Props) => <Host name="scroll" props={props} />;
export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  hairlineWidth: 1,
};
export const Linking = { openURL: async (_url: string) => {} };
