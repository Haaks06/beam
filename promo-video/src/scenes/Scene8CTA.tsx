import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { GridBackground } from "../components/GridBackground";
import { ParticleField } from "../components/ParticleField";
import { SparkIcon } from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE8_DURATION = 120;

const SITE_URL = "beamlot.com";
const ORBIT_SPARKS = 3;

export const Scene8CTA: React.FC = () => {
  const frame = useCurrentFrame();

  const label = springIn(frame, 6, 16, 15);
  const markIn = interpolate(frame, [12, 42], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.4)),
  });
  const markRotate = interpolate(markIn, [0, 1], [-180, 0]);
  const cta = springIn(frame, 48, 18, 14);
  const pulse = 1 + Math.sin(Math.max(0, frame - 60) * 0.12) * 0.025;
  const urlCard = springIn(frame, 66, 16, 14);

  return (
    <SceneWrapper durationInFrames={SCENE8_DURATION}>
      <AppWindow>
        <GridBackground opacity={0.4} />
        <ParticleField count={20} seed="scene8" />

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
              opacity: label,
              translate: `0px ${interpolate(label, [0, 1], [10, 0])}px`,
              fontFamily: FONT_MONO,
              fontSize: 13,
              letterSpacing: 4,
              color: COLORS.amber,
            }}
          >
            NO ACCOUNT NEEDED
          </div>

          <div
            style={{
              position: "relative",
              width: 190,
              height: 190,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: markIn,
            }}
          >
            {Array.from({ length: ORBIT_SPARKS }).map((_, i) => {
              const baseAngle = (i / ORBIT_SPARKS) * 360;
              const angle = ((baseAngle + frame * 1.6) * Math.PI) / 180;
              const radius = 88;
              const x = Math.cos(angle) * radius;
              const y = Math.sin(angle) * radius;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    translate: `${x - 8}px ${y - 8}px`,
                  }}
                >
                  <SparkIcon size={16} color={COLORS.amber} />
                </div>
              );
            })}

            <div
              style={{
                width: 108,
                height: 108,
                borderRadius: "50%",
                border: `2px solid ${COLORS.amber}`,
                background: COLORS.amberDim,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                rotate: `${markRotate}deg`,
              }}
            >
              <SparkIcon size={46} color={COLORS.amber} strokeWidth={1.5} />
            </div>
          </div>

          <div
            style={{
              opacity: cta,
              scale: `${pulse}`,
              fontFamily: FONT_UI,
              fontSize: 36,
              fontWeight: 800,
              color: COLORS.white,
              marginTop: 4,
            }}
          >
            Beam something now
          </div>

          <div
            style={{
              opacity: urlCard,
              translate: `0px ${interpolate(urlCard, [0, 1], [10, 0])}px`,
              padding: "12px 26px",
              borderRadius: 12,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 17,
                color: COLORS.amber,
                letterSpacing: 1,
              }}
            >
              {SITE_URL}
            </span>
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
