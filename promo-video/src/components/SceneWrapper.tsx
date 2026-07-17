import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

const IN = 16;
const OUT = 16;

export const SceneWrapper: React.FC<{
  durationInFrames: number;
  children: React.ReactNode;
}> = ({ durationInFrames, children }) => {
  const frame = useCurrentFrame();

  const inProgress = interpolate(frame, [0, IN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.spring({ damping: 26 }),
  });
  const outProgress = interpolate(
    frame,
    [durationInFrames - OUT, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.ease),
    },
  );
  const progress = Math.min(inProgress, outProgress);
  const scale = interpolate(progress, [0, 1], [0.95, 1]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        opacity: progress,
        scale: `${scale}`,
      }}
    >
      {children}
    </div>
  );
};

export const springIn = (
  frame: number,
  from: number,
  duration = 18,
  damping = 14,
) =>
  interpolate(frame, [from, from + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.spring({ damping }),
  });
