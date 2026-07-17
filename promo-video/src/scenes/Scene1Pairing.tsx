import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { QRCode } from "../components/QRCode";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";

const PAIRING_CODE = "7K2QXM";
const STATUS_LINES = [
  "Session opened",
  "Peer connected",
  "Direct P2P link established",
  "Encrypted relay fallback ready",
  "Session expires in 5:00",
  "No account · nothing stored",
];

export const SCENE1_DURATION = 120;

export const Scene1Pairing: React.FC = () => {
  const frame = useCurrentFrame();

  const slideProgress = interpolate(frame, [0, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const ty = (1 - slideProgress) * 70;
  const rx = (1 - slideProgress) * 20;
  const ry = Math.sin(frame * 0.045) * 3;

  const qrProgress = interpolate(frame, [8, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.ease),
  });

  const codeChars = Math.round(
    interpolate(frame, [44, 50], [0, PAIRING_CODE.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  const wordmark = springIn(frame, 54, 14, 11);

  return (
    <SceneWrapper durationInFrames={SCENE1_DURATION}>
      <AppWindow
        windowStyle={{
          transform: `translateY(${ty}px) rotateX(${rx}deg) rotateY(${ry}deg)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
          }}
        >
          <QRCode size={124} progress={qrProgress} seed="scene1" />

          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22,
              letterSpacing: 6,
              color: COLORS.amber,
              height: 28,
            }}
          >
            {PAIRING_CODE.slice(0, codeChars)}
            <span
              style={{
                opacity:
                  frame >= 44 && codeChars < PAIRING_CODE.length ? 1 : 0,
              }}
            >
              _
            </span>
          </div>

          <div
            style={{
              opacity: wordmark,
              scale: `${interpolate(wordmark, [0, 1], [0.85, 1])}`,
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 44,
              letterSpacing: 14,
              color: COLORS.amber,
              marginTop: 6,
            }}
          >
            BEAM
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              marginTop: 4,
              minWidth: 380,
            }}
          >
            {STATUS_LINES.map((line, i) => {
              const p = springIn(frame, 68 + i * 6, 12, 16);
              return (
                <div
                  key={line}
                  style={{
                    opacity: p,
                    translate: `${interpolate(p, [0, 1], [-10, 0])}px 0px`,
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    fontFamily: FONT_MONO,
                    fontSize: 14,
                    color: COLORS.muted,
                  }}
                >
                  <span style={{ color: COLORS.amber }}>›</span>
                  {line}
                </div>
              );
            })}
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
