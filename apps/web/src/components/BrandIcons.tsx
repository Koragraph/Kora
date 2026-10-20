import { cn } from "../util/utils";
import grokPng from "../assets/agent-grok.png";
import cursorPng from "../assets/agent-cursor.png";
import codexPng from "../assets/agent-codex.png";
import claudePng from "../assets/agent-claude.png";
import antigravityPng from "../assets/agent-antigravity.png";
import { type SVGProps, useId, type FC } from "react";

export type Icon = FC<SVGProps<SVGSVGElement>>;

// Agent marks keep their own brand colours (Claude's orange etc.): the Pitch "no hue" rule is for Kora's own UI,
// not for other products' logos, and a greyed Claude mark read as broken.
function rasterMark(src: string): Icon {
  return function RasterMark({ className, ...props }) {
    return (
      <svg viewBox="0 0 128 128" className={cn(className)} data-brand-hue="" {...props}>
        <image href={src} width="128" height="128" preserveAspectRatio="xMidYMid meet" />
      </svg>
    );
  };
}

export const ClaudeCodeIcon: Icon = rasterMark(claudePng);
export const CodexIcon: Icon = rasterMark(codexPng);
export const CursorIcon: Icon = rasterMark(cursorPng);
export const GrokIcon: Icon = rasterMark(grokPng);
export const AntigravityIcon: Icon = rasterMark(antigravityPng);

export const FinderIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <rect fill="#36A9F5" height="20" width="20" rx="4" y="2" x="2" />
    <path d="M12 2h6a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-6c-1.5-5-1.5-15 0-20Z" fill="#D9F1FF" />
    <path
      d="M8 8.5v2M16 8.5v2M7.5 15.5c2.5 2 6.5 2 9 0M12 4v8l-1 2.5"
      strokeLinecap="round"
      strokeWidth="1.5"
      stroke="#163A59"
    />
  </svg>
);

export const FileExplorerIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v1H2V6Z" fill="#D99A16" />
    <path d="M2 9h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9Z" fill="#FFCE45" />
    <rect x="12" y="11" width="8" height="7" rx="1" fill="#58B8E8" />
    <rect x="13.5" y="12.5" width="5" height="4" fill="#1879B9" />
  </svg>
);

export const LinuxIcon: Icon = (props) => (
  <svg viewBox="-2 -2 28 28" fill="currentColor" {...props}>
    <path d="M12 1c-2.2 0-3.6 2-3.6 4.4 0 1.3.3 2.2-.4 3.4C6.600 10.800 5 13.300 5 16c0 1.200.4 2 .9 2.600-.6.700-1.900 1.200-1.900 2.200 0 1.100 1.400 1.200 2.400 1.300 1 .1 1.900.4 2.600 1.100.4-.5.800-.7 1.400-.7h3c.6 0 1 .2 1.400.7.700-.7 1.600-1 2.600-1.100 1-.1 2.400-.2 2.400-1.300 0-1-1.300-1.500-1.900-2.200.5-.6.900-1.400.9-2.600 0-2.700-1.600-5.200-3-7.200-.700-1.200-.4-2.100-.4-3.400C15.600 3 14.200 1 12 1Zm-1.300 4a.9 1.300 0 1 1 0 2.600.9 1.300 0 0 1 0-2.600Zm2.600 0a.9 1.300 0 1 1 0 2.600.9 1.300 0 0 1 0-2.600ZM12 8.200c1 0 2 .6 2 1.200S13 10.600 12 10.600 10 10 10 9.400s1-1.200 2-1.200Z" />
  </svg>
);

// Octicons "mark-github" (MIT).
export const GitHubIcon: Icon = (props) => (
  <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

export const GeminiIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 0C12.600 6.800 17.200 11.400 24 12c-6.800.600-11.400 5.200-12 12-.600-6.800-5.200-11.400-12-12C6.800 11.400 11.400 6.800 12 0Z" />
  </svg>
);

export const TraeIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <rect x="1" y="4" width="3" height="14" />
    <rect x="4" y="18" width="18" height="3" />
    <rect x="4" y="4" width="18" height="3" />
    <rect x="19" y="7" width="3" height="11" />
    <path d="M11 10l2 2-2 2-2-2 2-2ZM16 10l2 2-2 2-2-2 2-2Z" />
  </svg>
);

export const KiroIcon: Icon = (props) => (
  <svg viewBox="0 0 1200 1200" fill="none" {...props}>
    <rect width="1200" height="1200" rx="260" fill="#9046FF" />
    <path
      d="M600 190c-176 0-290 140-290 340 0 90 22 160 22 160-50 70-102 150-60 210 40 56 120 8 170-60 30 30 90 50 158 50s128-20 158-50c50 68 130 116 170 60 42-60-10-140-60-210 0 0 22-70 22-160 0-200-114-340-290-340Z"
      fill="#fff"
    />
    <ellipse cx="520" cy="500" rx="34" ry="78" fill="#000" />
    <ellipse cx="680" cy="500" rx="34" ry="78" fill="#000" />
  </svg>
);

function VsCodeMark({
  back,
  blade,
  lobe,
  ...props
}: SVGProps<SVGSVGElement> & { back: string; blade: string; lobe: string }) {
  const uid = useId();
  const mask = `${uid}-mask`;
  const shade = `${uid}-shade`;
  return (
    <svg viewBox="0 0 100 100" fill="none" {...props}>
      <mask id={mask} x="0" y="0" width="100" height="100" maskUnits="userSpaceOnUse">
        <path
          d="M70.900 99.300a6.200 6.200 0 0 0 4.900-.2l20.600-9.900a6.200 6.200 0 0 0 3.500-5.600V16.400a6.200 6.200 0 0 0-3.500-5.600L75.800.9a6.200 6.200 0 0 0-7.100 1.200L29.400 38 12.100 24.900a4.200 4.200 0 0 0-5.400.2l-5.600 5.100a4.200 4.200 0 0 0 0 6.200L16.200 50 1.100 63.600a4.200 4.200 0 0 0 0 6.200l5.600 5.100a4.200 4.200 0 0 0 5.400.2L29.400 62 68.700 97.900a6.200 6.200 0 0 0 2.200 1.400ZM75 27.300 45.100 50 75 72.700V27.300Z"
          fill="#fff"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path
          d="M96.400 10.800 75.900.9a6.200 6.200 0 0 0-7.100 1.200L1.400 63.600a4.200 4.200 0 0 0 0 6.200l5.600 5.100a4.200 4.200 0 0 0 5.400.2L93.800 13.300c2.700-2 6.500-.1 6.500 3.300v-.2a6.200 6.200 0 0 0-3.900-5.600Z"
          fill={back}
        />
        <path
          d="M96.400 89.200 75.900 99.100a6.200 6.200 0 0 1-7.100-1.200L1.400 36.400a4.200 4.200 0 0 1 0-6.200l5.600-5.100a4.200 4.200 0 0 1 5.400-.2l81.400 61.800c2.700 2 6.500.1 6.500-3.300v.2a6.200 6.200 0 0 1-3.900 5.600Z"
          fill={lobe}
        />
        <path
          d="M75.900 99.100a6.200 6.200 0 0 1-7.100-1.200c2.300 2.300 6.200.7 6.200-2.600V4.700c0-3.300-3.900-4.900-6.200-2.600a6.200 6.200 0 0 1 7.100-1.200l20.500 9.900a6.200 6.200 0 0 1 3.600 5.600v67.200a6.200 6.200 0 0 1-3.600 5.600l-20.500 9.900Z"
          fill={blade}
        />
        <rect
          width="100"
          height="100"
          fill={`url(#${shade})`}
          style={{ mixBlendMode: "overlay" }}
          opacity="0.25"
        />
      </g>
      <defs>
        <linearGradient id={shade} x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" />
          <stop stopColor="#fff" stopOpacity="0" offset="1" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const VisualStudioCode: Icon = (props) => (
  <VsCodeMark back="#0065A9" blade="#007ACC" lobe="#1F9CF0" {...props} />
);
export const VisualStudioCodeInsiders: Icon = (props) => (
  <VsCodeMark back="#009a7c" blade="#00b294" lobe="#24bfa5" {...props} />
);

export const VSCodium: Icon = (props) => {
  const grad = `${useId()}-grad`;
  return (
    <svg viewBox="0 0 100 100" fill="none" {...props}>
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#62A0EA" />
          <stop offset="1" stopColor="#1A5FB4" />
        </linearGradient>
      </defs>
      <path
        d="M50 4 8 28v44l42 24 42-24V28L50 4Zm0 14 28 16v32L50 82 22 66V34l28-16Zm0 14L34 41v18l16 9 16-9V41l-16-9Z"
        fill={`url(#${grad})`}
      />
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const clip = `${useId()}-clip`;
  return (
    <svg viewBox="0 0 96 96" fill="none" {...props}>
      <defs>
        <clipPath id={clip}>
          <rect width="96" height="96" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.400c4 0 6 4.800 3.200 7.600L42.200 58H58V51h6v7.500a6 6 0 0 1-6 6H36.300L26.300 74.500H70V60h6v14.500a6 6 0 0 1-6 6H20.100L9.600 90.800C6.800 93.600 2 91.600 2 87.600V90h-.1c0 3 2.400 6 6.100 6H87a9 9 0 0 0 9-9V21h-6v66a3 3 0 0 1-3 3H33.800L84 39.800 84 6H9Z"
        />
      </g>
    </svg>
  );
};

export const OpenCodeIcon: Icon = ({ className, ...props }) => (
  <svg viewBox="0 0 32 40" fill="none" className={className} {...props}>
    <g className="dark:hidden">
      <path d="M0 0h32v40H0V0Zm8 8v24h16V8H8Z" fill="#211E1E" fillRule="evenodd" />
      <rect x="8" y="8" width="16" height="24" fill="#CFCECD" />
    </g>
    <g className="hidden dark:block">
      <path d="M0 0h32v40H0V0Zm8 8v24h16V8H8Z" fill="#F1ECEC" fillRule="evenodd" />
      <rect x="8" y="8" width="16" height="24" fill="#4B4646" />
    </g>
  </svg>
);

export const KoragentIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <path
      d="M12 2.500 20.500 7.300v9.400L12 21.500 3.500 16.700V7.300L12 2.500Z"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M9.500 8v8M9.500 12l4.500-4M10.800 11.300 14 16"
      strokeLinejoin="round"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </svg>
);
