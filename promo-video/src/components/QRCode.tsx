import React from "react";
import { random } from "remotion";
import { COLORS } from "../tokens";

const GRID = 17;
const FINDER_POS: [number, number][] = [
  [0, 0],
  [0, GRID - 7],
  [GRID - 7, 0],
];

const isFinderRing = (r: number, c: number, fr: number, fc: number) => {
  const dr = r - fr;
  const dc = c - fc;
  if (dr < 0 || dr > 6 || dc < 0 || dc > 6) return false;
  const onOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
  const onInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
  return onOuter || onInner;
};

const inFinderZone = (r: number, c: number) =>
  FINDER_POS.some(
    ([fr, fc]) => r >= fr - 1 && r <= fr + 7 && c >= fc - 1 && c <= fc + 7,
  );

const moduleFilled = (r: number, c: number, seed: string) => {
  for (const [fr, fc] of FINDER_POS) {
    if (r >= fr && r < fr + 7 && c >= fc && c < fc + 7) {
      return isFinderRing(r, c, fr, fc);
    }
  }
  if (inFinderZone(r, c)) return false;
  return random(`${seed}-${r}-${c}`) > 0.56;
};

export const QRCode: React.FC<{
  size: number;
  progress: number;
  color?: string;
  seed?: string;
}> = ({ size, progress, color = COLORS.amber, seed = "qr" }) => {
  const cell = size / GRID;
  const modules: React.ReactNode[] = [];
  const clamped = Math.max(0, Math.min(1, progress));

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (!moduleFilled(r, c, seed)) continue;
      const threshold = (r + c) / (2 * (GRID - 1));
      if (threshold > clamped) continue;
      modules.push(
        <rect
          key={`${r}-${c}`}
          x={c * cell}
          y={r * cell}
          width={cell * 0.86}
          height={cell * 0.86}
          rx={cell * 0.12}
          fill={color}
        />,
      );
    }
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {modules}
    </svg>
  );
};
