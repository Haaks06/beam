import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { ProgressRing } from "../components/ProgressRing";
import { Waveform } from "../components/Waveform";
import {
  CheckIcon,
  FileIcon,
  LaptopIcon,
  LinkIcon,
  PhoneIcon,
  PhotoIcon,
  VoiceMemoIcon,
  WifiOffIcon,
} from "../components/Icons";
import { springIn } from "../components/SceneWrapper";
import { SceneWrapper } from "../components/SceneWrapper";
import { COLORS, FONT_MONO } from "../tokens";
import { FONT_UI } from "../fonts";

export const SCENE3_DURATION = 160;

type TransferItem = {
  key: string;
  label: string;
  icon: React.FC<{ size?: number; color?: string }>;
  start: number;
  end: number;
  waveform?: boolean;
};

const ITEMS: TransferItem[] = [
  { key: "photo", label: "photo.jpg", icon: PhotoIcon, start: 24, end: 58 },
  {
    key: "memo",
    label: "memo.m4a",
    icon: VoiceMemoIcon,
    start: 66,
    end: 98,
    waveform: true,
  },
  { key: "link", label: "link", icon: LinkIcon, start: 104, end: 134 },
];

const STEPS = [
  { label: "Pairing", doneAt: 8 },
  { label: "Direct connection", doneAt: 18 },
  { label: "Sending", doneAt: 24 },
  { label: "Delivered", doneAt: 140 },
];

export const Scene3Transfer: React.FC = () => {
  const frame = useCurrentFrame();
  const intro = springIn(frame, 0, 18, 16);
  const overlay = springIn(frame, 34, 18, 15);

  const currentStepIdx = (() => {
    let idx = 0;
    STEPS.forEach((s, i) => {
      if (frame >= s.doneAt) idx = i;
    });
    return idx;
  })();

  return (
    <SceneWrapper durationInFrames={SCENE3_DURATION}>
      <AppWindow>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 40px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              width: "100%",
              maxWidth: 944,
            }}
          >
            {/* Phone */}
            <div
              style={{
                opacity: intro,
                translate: `${interpolate(intro, [0, 1], [-24, 0])}px 0px`,
                width: 150,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 90,
                  height: 150,
                  borderRadius: 16,
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.surface,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <PhoneIcon size={34} color={COLORS.muted} />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: COLORS.dim,
                  textAlign: "center",
                }}
              >
                <WifiOffIcon size={13} color={COLORS.dim} />
                Wi-Fi: OFF · Cellular only
              </div>
            </div>

            {/* Lane */}
            <div
              style={{
                position: "relative",
                flex: 1,
                height: 150,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "50%",
                  height: 2,
                  background: COLORS.border,
                  opacity: intro,
                }}
              />
              {ITEMS.map((item) => {
                const p = interpolate(
                  frame,
                  [item.start, item.end],
                  [0, 1],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                );
                const visibility = interpolate(
                  frame,
                  [item.start - 6, item.start, item.end, item.end + 8],
                  [0, 1, 1, 0],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                );
                if (visibility <= 0) return null;
                const Icon = item.icon;

                return (
                  <div
                    key={item.key}
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: `${p * 100}%`,
                      translate: "-50% -50%",
                      opacity: visibility,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        width: 54,
                        height: 54,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <div style={{ position: "absolute", inset: 0 }}>
                        <ProgressRing
                          progress={p}
                          size={54}
                          stroke={3.5}
                        />
                      </div>
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: "50%",
                          background: COLORS.surface,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon size={17} color={COLORS.amber} />
                      </div>
                    </div>
                    {item.waveform ? (
                      <Waveform
                        width={64}
                        height={16}
                        bars={16}
                        seed={item.key}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Laptop + panel */}
            <div
              style={{
                opacity: intro,
                translate: `${interpolate(intro, [0, 1], [24, 0])}px 0px`,
                width: 300,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.surface,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <LaptopIcon size={22} color={COLORS.muted} />
                </div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    color: COLORS.dim,
                  }}
                >
                  café-guest-wifi
                </div>
              </div>

              <div
                style={{
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.surface,
                  borderRadius: 12,
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {STEPS.map((s, i) => {
                  const done = frame >= s.doneAt;
                  return (
                    <div
                      key={s.label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontFamily: FONT_UI,
                        fontSize: 12.5,
                        color: done
                          ? COLORS.white
                          : i === currentStepIdx
                            ? COLORS.amber
                            : COLORS.dim,
                      }}
                    >
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          border: `1.5px solid ${done ? COLORS.green : i === currentStepIdx ? COLORS.amber : COLORS.border}`,
                          background: done ? COLORS.greenDim : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {done ? (
                          <CheckIcon size={9} color={COLORS.green} strokeWidth={3} />
                        ) : null}
                      </div>
                      {s.label}
                    </div>
                  );
                })}

                <div
                  style={{
                    height: 1,
                    background: COLORS.border,
                    margin: "4px 0",
                  }}
                />

                {ITEMS.map((item) => {
                  const delivered = frame >= item.end;
                  const Icon = item.key === "link" ? LinkIcon : item.key === "memo" ? VoiceMemoIcon : FileIcon;
                  return (
                    <div
                      key={item.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontFamily: FONT_MONO,
                        fontSize: 12,
                        color: delivered ? COLORS.white : COLORS.dim,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                        }}
                      >
                        <Icon size={13} color={delivered ? COLORS.amber : COLORS.dim} />
                        {item.label}
                      </div>
                      {delivered ? (
                        <CheckIcon size={13} color={COLORS.green} strokeWidth={2.5} />
                      ) : (
                        <div
                          style={{
                            width: 13,
                            height: 13,
                            borderRadius: "50%",
                            border: `1.5px solid ${COLORS.border}`,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 26,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            opacity: overlay,
            translate: `0px ${interpolate(overlay, [0, 1], [10, 0])}px`,
          }}
        >
          <div
            style={{
              padding: "8px 18px",
              borderRadius: 999,
              border: `1px solid ${COLORS.amber}55`,
              background: COLORS.amberDim,
              color: COLORS.amber,
              fontFamily: FONT_UI,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Not the same network. Still instant.
          </div>
        </div>
      </AppWindow>
    </SceneWrapper>
  );
};
