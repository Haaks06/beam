import React from "react";

type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
};

const base = (
  { size = 24, color = "currentColor", strokeWidth = 1.8, style }: IconProps,
  children: React.ReactNode,
) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {children}
  </svg>
);

export const LinkIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.6 4.9a3.4 3.4 0 0 1 4.8 4.8L15.8 11.3" />
      <path d="M13 17.5 11.4 19.1a3.4 3.4 0 0 1-4.8-4.8L8.2 12.7" />
    </>
  ));

export const TextNoteIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M6 4h9l3 3v13H6z" />
      <path d="M15 4v3h3" />
      <path d="M9 12h6M9 15.5h6M9 8.5h3" />
    </>
  ));

export const PhotoIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9.2" cy="10" r="1.5" />
      <path d="m5 17 4.5-4.5a1.5 1.5 0 0 1 2.1 0L15 16" />
      <path d="m13.5 14.5 1.6-1.6a1.5 1.5 0 0 1 2.1 0L19.5 15" />
    </>
  ));

export const FileIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M14 3.5v4h4" />
    </>
  ));

export const VoiceMemoIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="9.5" y="3.5" width="5" height="9" rx="2.5" />
      <path d="M6.5 11a5.5 5.5 0 0 0 11 0" />
      <path d="M12 16.5v3.5M9 20h6" />
    </>
  ));

export const PhoneIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </>
  ));

export const LaptopIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="4" y="4.5" width="16" height="10.5" rx="1.4" />
      <path d="M2.5 19.5h19l-1.5-3h-16z" />
    </>
  ));

export const WifiOffIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M3 3l18 18" />
      <path d="M5 8.8a13 13 0 0 1 4.6-2.6" />
      <path d="M13.6 6a13 13 0 0 1 5.4 2.8" />
      <path d="M8.3 12.5a7.2 7.2 0 0 1 3.4-1.7" />
      <path d="M15.3 12.9a7.2 7.2 0 0 1 1.7 1.3" />
      <path d="M11.4 16.3a3 3 0 0 1 2 .8" />
      <circle cx="12" cy="19.3" r="1" fill="currentColor" stroke="none" />
    </>
  ));

export const CellularIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M4 19V15" />
      <path d="M9 19V11" />
      <path d="M14 19V7" />
      <path d="M19 19V3" />
    </>
  ));

export const CheckIcon: React.FC<IconProps> = (p) =>
  base(p, <path d="M5 12.5 10 17.5 19 6.5" />);

export const SparkIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <path d="M12 2.5c.7 4 2.6 5.9 6.6 6.6-4 .7-5.9 2.6-6.6 6.6-.7-4-2.6-5.9-6.6-6.6 4-.7 5.9-2.6 6.6-6.6z" />
  ));

export const QRIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="3.5" y="3.5" width="6" height="6" rx="0.6" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="0.6" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="0.6" />
      <path d="M14.5 15h3v3h-3zM19.5 19.5h1M14.5 20.5h1" />
    </>
  ));

export const GlobeIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.6 2.3 4 5.3 4 8.5s-1.4 6.2-4 8.5c-2.6-2.3-4-5.3-4-8.5s1.4-6.2 4-8.5z" />
    </>
  ));

export const WindowsIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M3.5 6.2 11 5.1v6.5H3.5z" />
      <path d="M12.2 4.9 20.5 3.7v7.8h-8.3z" />
      <path d="M3.5 12.6h7.5v6.5l-7.5-1.1z" />
      <path d="M12.2 12.6h8.3v7.8l-8.3-1.2z" />
    </>
  ));

export const ShareSheetIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="5" y="9" width="14" height="12" rx="2.2" />
      <path d="M12 2.5v11" />
      <path d="M8.3 6.2 12 2.5l3.7 3.7" />
    </>
  ));

export const RightClickIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M7 3.8 18 9.4l-4.8 1.2-1.9 4.6z" />
      <path d="M11.3 14.6 15.5 20" />
    </>
  ));

export const ClipboardIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <rect x="6" y="4.5" width="12" height="16" rx="2" />
      <rect x="9" y="2.8" width="6" height="3.4" rx="1" />
      <path d="M9 11h6M9 14.5h6M9 17.5h4" />
    </>
  ));

export const TrayIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M12 3.5v8.5" />
      <path d="M8.2 8.5 12 12.2l3.8-3.7" />
      <path d="M4.5 14.5h15v5h-15z" />
    </>
  ));

export const PowerIcon: React.FC<IconProps> = (p) =>
  base(p, (
    <>
      <path d="M12 3.5v8" />
      <path d="M7 6.6a7.5 7.5 0 1 0 10 0" />
    </>
  ));

export const ChevronRightIcon: React.FC<IconProps> = (p) =>
  base(p, <path d="m9.5 6 6 6-6 6" />);
