import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Chip } from "../components/Chip";
import { QRIcon } from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_BRAND, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE2_DURATION = 150;

const CHIPS = ["Cross-network", "No account", "Auto-wipe"];

const fadeUp = (p: number) => ({
  opacity: p,
  translate: `0px ${interpolate(p, [0, 1], [16, 0])}px`,
});

export const Scene2Home: React.FC = () => {
  const frame = useCurrentFrame();

  const title = springIn(frame, 6, 20, 13);
  const tagline = springIn(frame, 24, 20, 13);
  const input = springIn(frame, 42, 20, 13);
  const chipsBase = 60;

  return (
    <SceneWrapper durationInFrames={SCENE2_DURATION}>
      <AppWindow>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 22,
          }}
        >
          <div
            style={{
              ...fadeUp(title),
              fontFamily: FONT_BRAND,
              fontSize: 76,
              color: COLORS.amber,
            }}
          >
            Beam
          </div>

          <div
            style={{
              ...fadeUp(tagline),
              fontFamily: FONT_UI,
              fontSize: 21,
              color: COLORS.muted,
            }}
          >
            Send anything, anywhere — then it&apos;s gone
          </div>

          <div
            style={{
              ...fadeUp(input),
              marginTop: 14,
              width: 380,
              height: 54,
              borderRadius: 27,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingLeft: 24,
              paddingRight: 6,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 15,
                color: COLORS.dim,
                letterSpacing: 1,
              }}
            >
              Enter pairing code
            </span>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: "50%",
                background: COLORS.amber,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <QRIcon size={20} color={COLORS.bg} strokeWidth={2} />
            </div>
          </div>

          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 10,
              justifyContent: "center",
            }}
          >
            {CHIPS.map((label, i) => {
              const p = springIn(frame, chipsBase + i * 6, 16, 13);
              return (
                <div key={label} style={fadeUp(p)}>
                  <Chip dotColor={COLORS.amber}>{label}</Chip>
                </div>
              );
            })}
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
