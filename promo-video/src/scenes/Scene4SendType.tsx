import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Badge } from "../components/Badge";
import {
  FileIcon,
  LinkIcon,
  PhotoIcon,
  TextNoteIcon,
  VoiceMemoIcon,
} from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE4_DURATION = 130;

const SEND_TYPES = [
  { key: "link", label: "Link", icon: LinkIcon },
  { key: "note", label: "Text note", icon: TextNoteIcon },
  { key: "photo", label: "Photo", icon: PhotoIcon },
  { key: "file", label: "File", icon: FileIcon, desktopOnly: true },
  { key: "memo", label: "Voice memo", icon: VoiceMemoIcon, desktopOnly: true },
];

const TIMERS = [
  { minutes: 2, desc: "Quick handoff" },
  { minutes: 5, desc: "Default for most transfers", isDefault: true },
  { minutes: 10, desc: "Slower networks" },
  { minutes: 15, desc: "Larger files" },
];

const ROW_H = 54;
const ROW_GAP = 10;

export const Scene4SendType: React.FC = () => {
  const frame = useCurrentFrame();
  const tagline = springIn(frame, 98, 18, 15);

  const selectedIdx = interpolate(
    frame,
    [16, 30, 70, 84],
    [0, 2, 2, 3],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.spring({ damping: 16 }),
    },
  );

  return (
    <SceneWrapper durationInFrames={SCENE4_DURATION}>
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
            gap: 26,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 28,
              width: "100%",
              maxWidth: 940,
            }}
          >
            {/* Left: send types */}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  letterSpacing: 2,
                  color: COLORS.dim,
                  marginBottom: 14,
                  textTransform: "uppercase",
                }}
              >
                Send
              </div>
              <div style={{ position: "relative" }}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: selectedIdx * (ROW_H + ROW_GAP),
                    height: ROW_H,
                    borderRadius: 12,
                    border: `1.5px solid ${COLORS.amber}`,
                    background: COLORS.amberDim,
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: ROW_GAP,
                    position: "relative",
                  }}
                >
                  {SEND_TYPES.map((type, i) => {
                    const p = springIn(frame, 10 + i * 8, 16, 14);
                    const Icon = type.icon;
                    return (
                      <div
                        key={type.key}
                        style={{
                          opacity: p,
                          translate: `${interpolate(p, [0, 1], [-16, 0])}px 0px`,
                          height: ROW_H,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "0 14px",
                        }}
                      >
                        <div
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 9,
                            background: COLORS.surfaceRaised,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Icon size={17} color={COLORS.amber} />
                        </div>
                        <span
                          style={{
                            fontFamily: FONT_UI,
                            fontSize: 15,
                            color: COLORS.white,
                          }}
                        >
                          {type.label}
                        </span>
                        {type.desktopOnly ? (
                          <Badge color="amber" style={{ marginLeft: "auto" }}>
                            Desktop app
                          </Badge>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right: session settings */}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  letterSpacing: 2,
                  color: COLORS.dim,
                  marginBottom: 14,
                  textTransform: "uppercase",
                }}
              >
                Session timer
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: ROW_GAP,
                }}
              >
                {TIMERS.map((t, i) => {
                  const p = springIn(frame, 34 + i * 8, 16, 14);
                  return (
                    <div
                      key={t.minutes}
                      style={{
                        opacity: p,
                        translate: `${interpolate(p, [0, 1], [16, 0])}px 0px`,
                        height: ROW_H,
                        borderRadius: 12,
                        border: `1.5px solid ${t.isDefault ? COLORS.amber : COLORS.border}`,
                        background: t.isDefault
                          ? COLORS.amberDim
                          : COLORS.surface,
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "0 16px",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 15,
                          fontWeight: 700,
                          color: t.isDefault ? COLORS.amber : COLORS.white,
                          width: 52,
                        }}
                      >
                        {t.minutes} min
                      </span>
                      <span
                        style={{
                          fontFamily: FONT_UI,
                          fontSize: 13,
                          color: COLORS.muted,
                        }}
                      >
                        {t.desc}
                      </span>
                      {t.isDefault ? (
                        <Badge color="amber" style={{ marginLeft: "auto" }}>
                          Default
                        </Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div
            style={{
              opacity: tagline,
              translate: `0px ${interpolate(tagline, [0, 1], [10, 0])}px`,
              fontFamily: FONT_UI,
              fontSize: 14,
              color: COLORS.dim,
              textAlign: "center",
            }}
          >
            Direct device-to-device first · encrypted relay fallback · wiped
            on timeout
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
