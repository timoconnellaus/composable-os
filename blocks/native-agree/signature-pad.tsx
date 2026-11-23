// The native signature pad (stage 44 step 5): drawn with a finger or a pen through React Native's
// own touch responder (PanResponder), no new native module. It records strokes in the host's
// format (`StrokeRecorder`: integer points in a 1000 by 400 box, within the host's limits) and
// draws them with plain Views, as thin rotated lines. Nothing is kept as an image.
//
// Drawing stays light: the screen is drawn again at most once a frame, a stroke's lines are drawn
// in runs of a few dozen that are not drawn again once full (memo), so a move redraws only the
// run being drawn, and one finger draws (a second finger on the pad adds nothing).
import { boxPoint, type StrokeRecorder } from "@composable-os/client";
import { memo, useMemo, useRef, useState } from "react";
import { type GestureResponderEvent, PanResponder, StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { theme } from "../native-base/theme.ts";

const INK = 3;
/** Lines per run: a full run is never drawn again. */
const RUN = 32;

export function SignaturePad({
  recorder,
  problem,
  onChange,
  onDrawing,
}: {
  /** Holds the strokes (the Agree block's, cleared after it agrees). */
  recorder: StrokeRecorder;
  problem: string | null;
  onChange: () => void;
  /** Told when drawing starts and stops, so a screen can stop scrolling meanwhile. */
  onDrawing?: (drawing: boolean) => void;
}) {
  const size = useRef({ width: 0, height: 0 });
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [, setDrawn] = useState(0);
  const redraw = () => setDrawn((n) => n + 1);
  const callbacks = useRef({ onChange, onDrawing });
  callbacks.current = { onChange, onDrawing };
  // At most one redraw a frame, however often the finger moves.
  const frame = useRef<number | null>(null);

  const responder = useMemo(() => {
    const at = (event: GestureResponderEvent) =>
      boxPoint(
        event.nativeEvent.locationX,
        event.nativeEvent.locationY,
        size.current.width,
        size.current.height,
      );
    const soon = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setDrawn((n) => n + 1);
      });
    };
    const lift = () => {
      recorder.end();
      setDrawn((n) => n + 1);
      callbacks.current.onDrawing?.(false);
      callbacks.current.onChange();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // A scrolling screen does not take the finger away mid-stroke.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        callbacks.current.onDrawing?.(true);
        recorder.begin(at(event));
        setDrawn((n) => n + 1);
      },
      onPanResponderMove: (event, gesture) => {
        // A second finger on the pad (a pinch, a palm) never draws a line to the first.
        if (gesture.numberActiveTouches > 1) return;
        if (recorder.extend(at(event))) soon();
      },
      onPanResponderRelease: lift,
      onPanResponderTerminate: lift,
    });
  }, [recorder]);

  const drawn = recorder.strokes.length > 0;
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Your signature</Text>
      <Text style={styles.hint}>
        Draw your signature in the box with your finger or a pen. If you cannot draw one, ask the
        business to record a paper form for you instead.
      </Text>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={drawn ? "Signature pad: signature drawn" : "Signature pad: empty"}
        accessibilityHint="Draw your signature with a finger"
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          size.current = { width, height };
          setLayout({ width, height });
        }}
        style={[styles.pad, problem ? styles.invalid : null]}
        {...responder.panHandlers}
      >
        <View pointerEvents="none" style={styles.baseline} />
        {recorder.strokes.map((stroke, i) => (
          <Stroke
            // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional and only grow.
            key={i}
            stroke={stroke}
            count={stroke.length}
            width={layout.width}
            height={layout.height}
          />
        ))}
      </View>
      <View style={styles.row}>
        <Button
          quiet
          label="Clear signature"
          disabled={!drawn}
          onPress={() => {
            recorder.clear();
            redraw();
            onChange();
          }}
        />
        <Text style={styles.hint} accessibilityLiveRegion="polite">
          {recorder.full
            ? "The box is full: clear it to start again."
            : drawn
              ? "Signature drawn."
              : "Nothing drawn yet."}
        </Text>
      </View>
      {problem ? (
        <Text style={styles.error} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One stroke, scaled from the box to the pad on screen, in runs of lines. `count` is how many
 * points it has now: the recorder's arrays grow in place, so it is what tells a run it changed.
 */
function Stroke({
  stroke,
  count,
  width,
  height,
}: {
  stroke: readonly (readonly [number, number])[];
  count: number;
  width: number;
  height: number;
}) {
  const first = stroke[0];
  if (!first) return null;
  if (count === 1) {
    return (
      <View
        pointerEvents="none"
        style={[
          styles.dot,
          { left: (first[0] * width) / 1000 - INK / 2, top: (first[1] * height) / 400 - INK / 2 },
        ]}
      />
    );
  }
  const runs: number[] = [];
  for (let from = 0; from < count - 1; from += RUN) runs.push(from);
  return (
    <>
      {runs.map((from) => (
        <Run
          key={from}
          stroke={stroke}
          from={from}
          to={Math.min(from + RUN, count - 1)}
          width={width}
          height={height}
        />
      ))}
    </>
  );
}

/** The lines from point `from` to point `to`: drawn again only when `to` or the size changes. */
const Run = memo(function Run({
  stroke,
  from,
  to,
  width,
  height,
}: {
  stroke: readonly (readonly [number, number])[];
  from: number;
  to: number;
  width: number;
  height: number;
}) {
  const sx = width / 1000;
  const sy = height / 400;
  const lines = [];
  for (let i = from; i < to; i++) {
    const a = stroke[i] as readonly [number, number];
    const b = stroke[i + 1] as readonly [number, number];
    const x0 = a[0] * sx;
    const y0 = a[1] * sy;
    const x1 = b[0] * sx;
    const y1 = b[1] * sy;
    const length = Math.hypot(x1 - x0, y1 - y0);
    lines.push(
      <View
        key={i}
        pointerEvents="none"
        style={[
          styles.segment,
          {
            width: length + INK,
            left: (x0 + x1) / 2 - (length + INK) / 2,
            top: (y0 + y1) / 2 - INK / 2,
            transform: [{ rotate: `${Math.atan2(y1 - y0, x1 - x0)}rad` }],
          },
        ]}
      />,
    );
  }
  return <>{lines}</>;
});

const styles = StyleSheet.create({
  wrap: { gap: theme.space.xs },
  label: { fontSize: theme.font.small, color: theme.color.muted },
  hint: { fontSize: theme.font.small, color: theme.color.muted, flexShrink: 1 },
  pad: {
    width: "100%",
    aspectRatio: 2.5,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    backgroundColor: theme.color.background,
    overflow: "hidden",
  },
  invalid: { borderColor: theme.color.danger },
  baseline: {
    position: "absolute",
    left: "4%",
    right: "4%",
    bottom: "17%",
    height: 1,
    backgroundColor: theme.color.border,
  },
  segment: {
    position: "absolute",
    height: INK,
    borderRadius: INK / 2,
    backgroundColor: theme.color.text,
  },
  dot: {
    position: "absolute",
    width: INK,
    height: INK,
    borderRadius: INK / 2,
    backgroundColor: theme.color.text,
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.space.sm, flexWrap: "wrap" },
  error: { fontSize: theme.font.small, color: theme.color.danger },
});
