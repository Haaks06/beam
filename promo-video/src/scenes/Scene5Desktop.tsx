import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Badge } from "../components/Badge";
import { Chip } from "../components/Chip";
import {
  CheckIcon,
  ClipboardIcon,
  FileIcon,
  PowerIcon,
  RightClickIcon,
  TrayIcon,
  VoiceMemoIcon,
} from "../components/Icons";
import { SceneWrapper, springIn } from "../components/SceneWrapper";
import { COLORS } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE5_DURATION = 140;

const CATEGORIES = ["All", "Quick-send", "Integration", "Privacy"];

const FEATURES = [
  {
    key: "rightclick",
    icon: RightClickIcon,
    title: 'Right-click "Beam this file"',
  },
  { key: "clipboard", icon: ClipboardIcon, title: "Clipboard watch" },
  { key: "tray", icon: TrayIcon, title: "System-tray listener" },
  {
    key: "autolaunch",
    icon: PowerIcon,
    title: "Auto-launch at startup",
  },
  {
    key: "file",
    icon: FileIcon,
    title: "File sending",
    desktopOnly: true,
  },
  {
    key: "memo",
    icon: VoiceMemoIcon,
    title: "Voice memos",
    desktopOnly: true,
  },
];

export const Scene5Desktop: React.FC = () => {
  const frame = useCurrentFrame();
  const backdrop = springIn(frame, 0, 16, 20);
  const modal = springIn(frame, 2, 20, 13);

  return (
    <SceneWrapper durationInFrames={SCENE5_DURATION}>
      <AppWindow>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            opacity: backdrop,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              opacity: modal,
              scale: `${interpolate(modal, [0, 1], [0.93, 1])}`,
              width: 900,
              borderRadius: 16,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
              boxShadow: "0 30px 70px rgba(0,0,0,0.5)",
              padding: 28,
            }}
          >
            <div
              style={{
                fontFamily: FONT_UI,
                fontSize: 20,
                fontWeight: 700,
                color: COLORS.white,
                marginBottom: 18,
              }}
            >
              Beam Desktop — more than the browser
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
              {CATEGORIES.map((cat, i) => {
                const p = springIn(frame, 18 + i * 6, 14, 14);
                return (
                  <div
                    key={cat}
                    style={{
                      opacity: p,
                      translate: `0px ${interpolate(p, [0, 1], [8, 0])}px`,
                    }}
                  >
                    <Chip active={i === 0}>{cat}</Chip>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 16,
              }}
            >
              {FEATURES.map((f, i) => {
                const p = springIn(frame, 32 + i * 7, 16, 14);
                const Icon = f.icon;
                return (
                  <div
                    key={f.key}
                    style={{
                      opacity: p,
                      translate: `0px ${interpolate(p, [0, 1], [14, 0])}px`,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 12,
                      background: COLORS.surfaceRaised,
                      padding: 16,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      minHeight: 128,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                      }}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 9,
                          background: COLORS.amberDim,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon size={18} color={COLORS.amber} />
                      </div>
                      <div
                        style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}
                      >
                        <Badge color="green">Included</Badge>
                        {f.desktopOnly ? (
                          <Badge color="amber">Desktop only</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div
                      style={{
                        fontFamily: FONT_UI,
                        fontSize: 14,
                        color: COLORS.white,
                        fontWeight: 600,
                        lineHeight: 1.3,
                      }}
                    >
                      {f.title}
                    </div>
                    <div
                      style={{
                        marginTop: "auto",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        alignSelf: "flex-start",
                        padding: "5px 10px",
                        borderRadius: 7,
                        border: `1px solid ${COLORS.border}`,
                        fontFamily: FONT_UI,
                        fontSize: 12,
                        color: COLORS.muted,
                      }}
                    >
                      <CheckIcon size={12} color={COLORS.green} strokeWidth={3} />
                      Enabled
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
