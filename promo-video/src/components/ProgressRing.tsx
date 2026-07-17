import React from "react";
import { COLORS } from "../tokens";

export const ProgressRing: React.FC<{
  progress: number;
  size?: number;
  stroke?: number;
  color?: string;
  trackColor?: string;
}> = ({
  progress,
  size = 54,
  stroke = 4,
  color = COLORS.amber,
  trackColor = COLORS.border,
}) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = c * (1 - clamped);

  return (
    <svg width={size} height={size} style={{ rotate: "-90deg" }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={trackColor}
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
};
