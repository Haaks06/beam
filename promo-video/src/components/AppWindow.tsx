import React from "react";
import { useVideoConfig } from "remotion";
import { COLORS, MAC_DOTS } from "../tokens";

const MARGIN = 28;
const HEADER_H = 40;

export const AppWindow: React.FC<{
  children: React.ReactNode;
  windowStyle?: React.CSSProperties;
  contentBackground?: string;
}> = ({ children, windowStyle, contentBackground }) => {
  const { width, height } = useVideoConfig();
  const w = width - MARGIN * 2;
  const h = height - MARGIN * 2;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        perspective: 1400,
      }}
    >
      <div
        style={{
          position: "relative",
          width: w,
          height: h,
          borderRadius: 14,
          border: `1px solid ${COLORS.border}`,
          background: COLORS.bg,
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          ...windowStyle,
        }}
      >
        <div
          style={{
            height: HEADER_H,
            minHeight: HEADER_H,
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingLeft: 16,
            borderBottom: `1px solid ${COLORS.border}`,
            background: COLORS.surface,
          }}
        >
          {MAC_DOTS.map((c) => (
            <div
              key={c}
              style={{
                width: 11,
                height: 11,
                borderRadius: "50%",
                background: c,
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            background: contentBackground ?? COLORS.bg,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
