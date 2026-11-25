// React Native's components as plain elements, for drawing the native blocks in a test (as
// packs/content/test/react-native-shim.tsx does): each renders `<rn-<name>>` with its testID,
// accessibility role and label. What a phone paints is React Native's; what this checks is what a
// block says and which presses it offers. Every press drawn is kept in `presses` with its text, so
// a test can press one the way a person would.
import { Children, createElement, isValidElement, type ReactNode } from "react";

type Props = {
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  [key: string]: unknown;
};

/** The words inside an element as given (its children's strings), before it is drawn. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode; title?: unknown; label?: unknown }>(node)) {
    const { children, title, label } = node.props;
    const own = [title, label].filter((v): v is string => typeof v === "string").join(" ");
    return [own, Children.toArray(children).map(textOf).join("")].filter(Boolean).join(" ");
  }
  return "";
}

/** Each press drawn since `presses.length = 0`: its words, and what it does. */
export const presses: { text: string; onPress: () => void; disabled: boolean }[] = [];

function Host({ name, props }: { name: string; props: Props }) {
  const { testID, accessibilityRole, accessibilityLabel, children } = props;
  return createElement(
    `rn-${name}`,
    {
      ...(testID ? { "data-testid": testID } : {}),
      ...(accessibilityRole ? { "data-role": accessibilityRole } : {}),
      ...(accessibilityLabel ? { "data-label": accessibilityLabel } : {}),
    },
    children,
  );
}

export const View = (props: Props) => <Host name="view" props={props} />;
export const Text = (props: Props) => <Host name="text" props={props} />;
export const ScrollView = (props: Props) => <Host name="scroll" props={props} />;
export const SafeAreaView = (props: Props) => <Host name="safe-area" props={props} />;
export const Modal = (props: Props) => <Host name="modal" props={props} />;
export const ActivityIndicator = () => <Host name="spinner" props={{}} />;
export const TextInput = (props: Props) => (
  <Host name="input" props={{ ...props, children: String(props.value ?? "") }} />
);
export const Pressable = (props: Props) => {
  if (props.onPress) {
    presses.push({
      text: textOf(props.children),
      onPress: props.onPress,
      disabled: Boolean(props.disabled),
    });
  }
  return <Host name="pressable" props={props} />;
};
export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  hairlineWidth: 1,
  flatten: <T,>(style: T): T => style,
};
export const Linking = { openURL: async (_url: string) => {} };
export const PanResponder = { create: () => ({ panHandlers: {} }) };
