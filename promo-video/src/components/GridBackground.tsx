import React from "react";
import { COLORS } from "../tokens";

export const GridBackground: React.FC<{ opacity?: number }> = ({
  opacity = 0.5,
}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      backgroundImage: `linear-gradient(${COLORS.border} 1px, transparent 1px), linear-gradient(90deg, ${COLORS.border} 1px, transparent 1px)`,
      backgroundSize: "42px 42px",
      opacity,
      maskImage:
        "radial-gradient(ellipse at center, black 0%, transparent 75%)",
      WebkitMaskImage:
        "radial-gradient(ellipse at center, black 0%, transparent 75%)",
    }}
  />
);
