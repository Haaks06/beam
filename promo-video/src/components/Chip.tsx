import React from "react";
import { COLORS, FONT_MONO } from "../tokens";

export const Chip: React.FC<{
  children: React.ReactNode;
  dotColor?: string;
  active?: boolean;
  mono?: boolean;
  style?: React.CSSProperties;
}> = ({ children, dotColor, active, mono, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      padding: "7px 14px",
      borderRadius: 999,
      border: `1px solid ${active ? COLORS.amber : COLORS.border}`,
      background: active ? COLORS.amberDim : COLORS.surface,
      color: active ? COLORS.amber : COLORS.muted,
      fontFamily: mono ? FONT_MONO : undefined,
      fontSize: 13,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {dotColor ? (
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />
    ) : null}
    {children}
  </div>
);
