import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import {
  GlobeIcon,
  QRIcon,
  ShareSheetIcon,
  WindowsIcon,
} from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE6_DURATION = 120;

const TAGS = ["Instant", "Cross-network", "Ephemeral"];

const PLATFORMS = [
  { key: "web", label: "Web app", icon: GlobeIcon },
  { key: "windows", label: "Windows desktop", icon: WindowsIcon },
  { key: "ios", label: "iOS Share Sheet", icon: ShareSheetIcon },
  { key: "qr", label: "QR pairing", icon: QRIcon },
];

export const Scene6Everywhere: React.FC = () => {
  const frame = useCurrentFrame();
  const headline = springIn(frame, 6, 18, 15);
  const subtitle = springIn(frame, 20, 18, 15);

  return (
    <SceneWrapper durationInFrames={SCENE6_DURATION}>
      <AppWindow>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 44px",
            gap: 34,
          }}
        >
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                opacity: headline,
                translate: `0px ${interpolate(headline, [0, 1], [14, 0])}px`,
                fontFamily: FONT_UI,
                fontSize: 38,
                fontWeight: 800,
                color: COLORS.white,
                letterSpacing: -0.5,
              }}
            >
              One link. Any two devices.
            </div>
            <div
              style={{
                opacity: subtitle,
                translate: `0px ${interpolate(subtitle, [0, 1], [10, 0])}px`,
                fontFamily: FONT_UI,
                fontSize: 16,
                color: COLORS.muted,
              }}
            >
              No app-store download · No login · Nothing left behind
            </div>
          </div>

          <div style={{ display: "flex", gap: 18, width: "100%", maxWidth: 940 }}>
            {PLATFORMS.map((p, i) => {
              const spring = springIn(frame, 36 + i * 10, 20, 11);
              const Icon = p.icon;
              return (
                <div
                  key={p.key}
                  style={{
                    opacity: spring,
                    scale: `${interpolate(spring, [0, 1], [0.8, 1], {
                      easing: Easing.out(Easing.ease),
                    })}`,
                    flex: 1,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 14,
                    background: COLORS.surface,
                    padding: "20px 16px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 12,
                      background: COLORS.amberDim,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon size={22} color={COLORS.amber} />
                  </div>
                  <div
                    style={{
                      fontFamily: FONT_UI,
                      fontSize: 14.5,
                      fontWeight: 700,
                      color: COLORS.white,
                    }}
                  >
                    {p.label}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: FONT_MONO,
                      fontSize: 11.5,
                      color: COLORS.green,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: COLORS.green,
                      }}
                    />
                    Ready
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 5,
                      justifyContent: "center",
                      marginTop: 2,
                    }}
                  >
                    {TAGS.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontFamily: FONT_UI,
                          fontSize: 10,
                          color: COLORS.dim,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 999,
                          padding: "3px 8px",
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
