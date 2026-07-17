import React from "react";
import { random, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../tokens";

export const ParticleField: React.FC<{ count?: number; seed?: string }> = ({
  count = 22,
  seed = "particles",
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: count }).map((_, i) => {
        const x0 = random(`${seed}-x-${i}`) * width;
        const size = 1.5 + random(`${seed}-s-${i}`) * 2.5;
        const speed = 0.25 + random(`${seed}-v-${i}`) * 0.45;
        const phase = random(`${seed}-p-${i}`) * Math.PI * 2;
        const sway = 12 + random(`${seed}-w-${i}`) * 18;
        const baseOpacity = 0.15 + random(`${seed}-o-${i}`) * 0.35;
        const yStart = random(`${seed}-y-${i}`) * (height + 40);

        const y = height - ((frame * speed + yStart) % (height + 40));
        const x = x0 + Math.sin(frame * 0.02 + phase) * sway;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: size,
              height: size,
              borderRadius: "50%",
              background: COLORS.amber,
              opacity: baseOpacity,
            }}
          />
        );
      })}
    </div>
  );
};
