import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, interpolate, staticFile } from "remotion";
import { Scene1Pairing, SCENE1_DURATION } from "./scenes/Scene1Pairing";
import { Scene2Home, SCENE2_DURATION } from "./scenes/Scene2Home";
import { Scene3Transfer, SCENE3_DURATION } from "./scenes/Scene3Transfer";
import { Scene4SendType, SCENE4_DURATION } from "./scenes/Scene4SendType";
import { Scene5Desktop, SCENE5_DURATION } from "./scenes/Scene5Desktop";
import { Scene6Everywhere, SCENE6_DURATION } from "./scenes/Scene6Everywhere";
import {
  Scene7BrandCombo,
  SCENE7_DURATION,
} from "./scenes/Scene7BrandCombo";
import { Scene8CTA, SCENE8_DURATION } from "./scenes/Scene8CTA";
import { COLORS } from "./tokens";

const SCENES = [
  { Component: Scene1Pairing, duration: SCENE1_DURATION },
  { Component: Scene2Home, duration: SCENE2_DURATION },
  { Component: Scene3Transfer, duration: SCENE3_DURATION },
  { Component: Scene4SendType, duration: SCENE4_DURATION },
  { Component: Scene5Desktop, duration: SCENE5_DURATION },
  { Component: Scene6Everywhere, duration: SCENE6_DURATION },
  { Component: Scene7BrandCombo, duration: SCENE7_DURATION },
  { Component: Scene8CTA, duration: SCENE8_DURATION },
];

export const BEAM_PROMO_DURATION = SCENES.reduce(
  (sum, s) => sum + s.duration,
  0,
);

const FADE_IN = 30; // 1s
const FADE_OUT = 60; // 2s
const MAX_VOLUME = 0.4;

export const BeamPromo: React.FC = () => {
  let cursor = 0;
  const offsets = SCENES.map((s) => {
    const from = cursor;
    cursor += s.duration;
    return from;
  });

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {SCENES.map(({ Component, duration }, i) => (
        <Sequence
          key={i}
          from={offsets[i]}
          durationInFrames={duration}
          name={`Scene ${i + 1}`}
        >
          <Component />
        </Sequence>
      ))}

      <Audio
        src={staticFile("headphonk.mp3")}
        volume={(f: number) =>
          interpolate(
            f,
            [
              0,
              FADE_IN,
              BEAM_PROMO_DURATION - FADE_OUT,
              BEAM_PROMO_DURATION,
            ],
            [0, MAX_VOLUME, MAX_VOLUME, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
    </AbsoluteFill>
  );
};
