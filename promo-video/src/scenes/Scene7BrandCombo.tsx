import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { GridBackground } from "../components/GridBackground";
import { ParticleField } from "../components/ParticleField";
import {
  FileIcon,
  GlobeIcon,
  LinkIcon,
  PhotoIcon,
  ShareSheetIcon,
  TextNoteIcon,
  VoiceMemoIcon,
  WindowsIcon,
} from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE7_DURATION = 180;

const HEADLINE_WORDS = ["Send", "it.", "Then", "it's", "gone."];

const SEND_ICONS = [
  { key: "link", icon: LinkIcon, label: "Link" },
  { key: "photo", icon: PhotoIcon, label: "Photo" },
  { key: "file", icon: FileIcon, label: "File" },
  { key: "memo", icon: VoiceMemoIcon, label: "Voice" },
  { key: "note", icon: TextNoteIcon, label: "Text" },
];

const DEVICE_ROW_1 = [
  { key: "web", icon: GlobeIcon, label: "Web" },
  { key: "windows", icon: WindowsIcon, label: "Desktop" },
];
const DEVICE_ROW_2 = [{ key: "ios", icon: ShareSheetIcon, label: "iOS" }];

const CONVERGE_LINES = 8;

const BeatA: React.FC<{ opacity: number }> = ({ opacity }) => {
  const frame = useCurrentFrame();
  const cx = 500;
  const cy = 300;
  const outerR = 620;

  const burst = interpolate(frame, [30, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <GridBackground opacity={0.4} />
      <ParticleField count={18} seed="scene7a" />
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1000 600"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0 }}
      >
        {Array.from({ length: CONVERGE_LINES }).map((_, i) => {
          const angle = (i / CONVERGE_LINES) * Math.PI * 2;
          const delay = i * 2.5;
          const p = interpolate(frame, [delay, delay + 24], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const segLen = 150;
          const travel = outerR * p;
          const innerR = Math.max(0, outerR - travel);
          const headR = Math.max(0, innerR);
          const tailR = Math.min(outerR, innerR + segLen);
          const head = {
            x: cx + Math.cos(angle) * headR,
            y: cy + Math.sin(angle) * headR,
          };
          const tail = {
            x: cx + Math.cos(angle) * tailR,
            y: cy + Math.sin(angle) * tailR,
          };
          const fade = interpolate(p, [0, 0.15, 0.85, 1], [0, 1, 1, 0]);
          return (
            <line
              key={i}
              x1={tail.x}
              y1={tail.y}
              x2={head.x}
              y2={head.y}
              stroke={COLORS.amber}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={fade}
            />
          );
        })}
        <circle
          cx={cx}
          cy={cy}
          r={20 + burst * 220}
          stroke={COLORS.amber}
          strokeWidth={2.5}
          fill="none"
          opacity={interpolate(burst, [0, 0.15, 1], [0, 0.9, 0])}
        />
        <circle cx={cx} cy={cy} r={5} fill={COLORS.amber} opacity={outerPtOpacity(frame)} />
      </svg>
    </div>
  );
};

const outerPtOpacity = (frame: number) =>
  interpolate(frame, [24, 34, 50], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const BeatB: React.FC<{ opacity: number }> = ({ opacity }) => {
  const frame = useCurrentFrame();
  const label = springIn(frame, 58, 16, 14);
  const sub = springIn(frame, 118, 16, 14);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
      }}
    >
      <div
        style={{
          opacity: label,
          translate: `0px ${interpolate(label, [0, 1], [10, 0])}px`,
          fontFamily: FONT_MONO,
          fontSize: 14,
          letterSpacing: 4,
          color: COLORS.amber,
        }}
      >
        ✦ Introducing ✦
      </div>

      <div
        style={{
          display: "flex",
          gap: 14,
          fontFamily: FONT_UI,
          fontSize: 56,
          fontWeight: 800,
          color: COLORS.white,
        }}
      >
        {HEADLINE_WORDS.map((word, i) => {
          const p = springIn(frame, 70 + i * 7, 16, 13);
          return (
            <span
              key={word}
              style={{
                opacity: p,
                translate: `0px ${interpolate(p, [0, 1], [18, 0])}px`,
                display: "inline-block",
              }}
            >
              {word}
            </span>
          );
        })}
      </div>

      <div
        style={{
          opacity: sub,
          translate: `0px ${interpolate(sub, [0, 1], [10, 0])}px`,
          fontFamily: FONT_MONO,
          fontSize: 15,
          color: COLORS.muted,
          letterSpacing: 1,
        }}
      >
        no accounts · no history · gone in minutes
      </div>
    </div>
  );
};

const BeatC: React.FC<{ opacity: number }> = ({ opacity }) => {
  const frame = useCurrentFrame();
  const tagline = springIn(frame, 166, 14, 15);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 30,
      }}
    >
      <div style={{ display: "flex", gap: 26 }}>
        {SEND_ICONS.map((item, i) => {
          const p = springIn(frame, 132 + i * 6, 16, 12);
          const Icon = item.icon;
          return (
            <div
              key={item.key}
              style={{
                opacity: p,
                scale: `${interpolate(p, [0, 1], [0.7, 1])}`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  background: COLORS.amberDim,
                  border: `1px solid ${COLORS.amber}44`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon size={22} color={COLORS.amber} />
              </div>
              <span
                style={{
                  fontFamily: FONT_UI,
                  fontSize: 12,
                  color: COLORS.muted,
                }}
              >
                {item.label}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", gap: 20 }}>
          {DEVICE_ROW_1.map((item, i) => (
            <DeviceChip key={item.key} item={item} frame={frame} delay={148 + i * 6} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          {DEVICE_ROW_2.map((item, i) => (
            <DeviceChip key={item.key} item={item} frame={frame} delay={160 + i * 6} />
          ))}
        </div>
      </div>

      <div
        style={{
          opacity: tagline,
          fontFamily: FONT_MONO,
          fontSize: 13,
          color: COLORS.dim,
          letterSpacing: 0.5,
        }}
      >
        Cross-network · Encrypted in transit · Auto-wipe | Web · Desktop · iOS
      </div>
    </div>
  );
};

const DeviceChip: React.FC<{
  item: { key: string; icon: React.FC<{ size?: number; color?: string }>; label: string };
  frame: number;
  delay: number;
}> = ({ item, frame, delay }) => {
  const p = springIn(frame, delay, 16, 13);
  const Icon = item.icon;
  return (
    <div
      style={{
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [10, 0])}px`,
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 999,
        padding: "7px 14px 7px 10px",
        background: COLORS.surface,
      }}
    >
      <Icon size={15} color={COLORS.amber} />
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: COLORS.green,
        }}
      />
      <span
        style={{
          fontFamily: FONT_UI,
          fontSize: 13,
          color: COLORS.white,
        }}
      >
        {item.label}
      </span>
    </div>
  );
};

export const Scene7BrandCombo: React.FC = () => {
  const frame = useCurrentFrame();

  const aOpacity = interpolate(frame, [0, 8, 50, 64], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bOpacity = interpolate(frame, [56, 68, 118, 132], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cOpacity = interpolate(frame, [126, 140], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneWrapper durationInFrames={SCENE7_DURATION}>
      <AppWindow>
        <BeatA opacity={aOpacity} />
        <BeatB opacity={bOpacity} />
        <BeatC opacity={cOpacity} />
      </AppWindow>
    </SceneWrapper>
  );
};
