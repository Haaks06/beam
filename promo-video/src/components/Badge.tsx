import React from "react";
import { COLORS } from "../tokens";

export const Badge: React.FC<{
  children: React.ReactNode;
  color: "green" | "amber";
  style?: React.CSSProperties;
}> = ({ children, color, style }) => {
  const c = color === "green" ? COLORS.green : COLORS.amber;
  const bg = color === "green" ? COLORS.greenDim : COLORS.amberDim;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        color: c,
        background: bg,
        border: `1px solid ${c}40`,
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </span>
  );
};
