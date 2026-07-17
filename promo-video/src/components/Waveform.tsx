import React from "react";
import { random } from "remotion";
import { COLORS } from "../tokens";

export const Waveform: React.FC<{
  bars?: number;
  progress?: number;
  width: number;
  height?: number;
  color?: string;
  seed?: string;
}> = ({
  bars = 28,
  progress = 1,
  width,
  height = 32,
  color = COLORS.amber,
  seed = "wave",
}) => {
  const gap = 3;
  const barWidth = (width - gap * (bars - 1)) / bars;
  const visible = Math.round(bars * Math.max(0, Math.min(1, progress)));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap,
        width,
        height,
      }}
    >
      {Array.from({ length: bars }).map((_, i) => {
        const h = 0.22 + random(`${seed}-${i}`) * 0.78;
        const shown = i < visible;
        return (
          <div
            key={i}
            style={{
              width: barWidth,
              height: shown ? `${h * 100}%` : "10%",
              borderRadius: 2,
              background: color,
              opacity: shown ? 1 : 0.25,
            }}
          />
        );
      })}
    </div>
  );
};
