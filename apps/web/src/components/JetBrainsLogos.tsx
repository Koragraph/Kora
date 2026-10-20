import { useId } from "react";

import type { Icon } from "./BrandIcons";

type Stop = readonly [offset: number, color: string];
interface LogoSpec {
  readonly letters: string;
  readonly a: {
    from: readonly [number, number];
    to: readonly [number, number];
    stops: readonly Stop[];
  };
  readonly b: {
    from: readonly [number, number];
    to: readonly [number, number];
    stops: readonly Stop[];
  };
  readonly accent: string;
}

// Product-logo skeleton: two gradient wedges, a small accent tab, the black plate and its letters.
function jetBrainsLogo(spec: LogoSpec): Icon {
  return function JetBrainsLogo(props) {
    const uid = useId();
    const idA = `${uid}-a`;
    const idB = `${uid}-b`;
    const gradient = (id: string, g: LogoSpec["a"]) => (
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1={g.from[0]}
        y1={g.from[1]}
        x2={g.to[0]}
        y2={g.to[1]}
      >
        {g.stops.map(([offset, color]) => (
          <stop key={offset} offset={offset} stopColor={color} />
        ))}
      </linearGradient>
    );
    return (
      <svg viewBox="0 0 64 64" fill="none" {...props}>
        <defs>
          {gradient(idA, spec.a)}
          {gradient(idB, spec.b)}
        </defs>
        <path d="M17 0 0 16v28l12 20 36-8 16-24L52 4 36 0H17Z" fill={`url(#${idA})`} />
        <path d="M64 0 36 0 0 36v28h20l44-30V0Z" fill={`url(#${idB})`} opacity="0.85" />
        <path d="M0 40h14v10L0 60V40Z" fill={spec.accent} />
        <rect x="12" y="12" width="40" height="40" fill="#000" />
        <text
          x="16"
          y="38"
          fill="#fff"
          fontFamily="Helvetica, Arial, sans-serif"
          fontSize="17"
          fontWeight="700"
        >
          {spec.letters}
        </text>
        <rect x="16" y="43" width="18" height="3" fill="#fff" />
      </svg>
    );
  };
}

export const AquaIcon = jetBrainsLogo({
  letters: "AQ",
  a: {
    from: [59.932, 59.676],
    to: [1.336, 1.079],
    stops: [
      [0.25, "#7256FF"],
      [0.73, "#007DFE"],
    ],
  },
  b: {
    from: [7.671, 64.392],
    to: [61.125, 39.609],
    stops: [
      [0.3, "#00D886"],
      [0.54, "#7256FF"],
    ],
  },
  accent: "#00D886",
});
export const CLionIcon = jetBrainsLogo({
  letters: "CL",
  a: {
    from: [4.067, 4.327],
    to: [62.664, 62.923],
    stops: [
      [0.29, "#009AE5"],
      [0.7, "#00D980"],
    ],
  },
  b: {
    from: [56.329, -0.391],
    to: [2.874, 24.393],
    stops: [
      [0.3, "#FF2D90"],
      [0.54, "#009AE5"],
    ],
  },
  accent: "#FF2D90",
});
export const DataGripIcon = jetBrainsLogo({
  letters: "DG",
  a: {
    from: [59.676, 4.067],
    to: [1.08, 62.663],
    stops: [
      [0.28, "#7256FF"],
      [0.66, "#00D980"],
    ],
  },
  b: {
    from: [64.391, 56.329],
    to: [39.607, 2.874],
    stops: [
      [0.3, "#FF43F2"],
      [0.54, "#7256FF"],
    ],
  },
  accent: "#FF43F2",
});
export const DataSpellIcon = jetBrainsLogo({
  letters: "DS",
  a: {
    from: [4.067, 4.327],
    to: [62.664, 62.923],
    stops: [
      [0.28, "#007DFE"],
      [0.73, "#00D980"],
    ],
  },
  b: {
    from: [56.329, -0.391],
    to: [2.875, 24.392],
    stops: [
      [0.32, "#F0EB18"],
      [0.55, "#007DFE"],
    ],
  },
  accent: "#F0EB18",
});
export const GoLandIcon = jetBrainsLogo({
  letters: "GO",
  a: {
    from: [64.391, 56.329],
    to: [39.607, 2.874],
    stops: [
      [0.24, "#00D886"],
      [0.51, "#007DFE"],
    ],
  },
  b: {
    from: [59.676, 4.067],
    to: [1.08, 62.663],
    stops: [
      [0.27, "#007DFE"],
      [0.7, "#D249FC"],
    ],
  },
  accent: "#00D886",
});
export const IntelliJIdeaIcon = jetBrainsLogo({
  letters: "IJ",
  a: {
    from: [-0.391, 7.671],
    to: [24.392, 61.126],
    stops: [
      [0.1, "#FC801D"],
      [0.59, "#FE2857"],
    ],
  },
  b: {
    from: [4.325, 59.932],
    to: [62.921, 1.336],
    stops: [
      [0.21, "#FE2857"],
      [0.7, "#007EFF"],
    ],
  },
  accent: "#FF8100",
});
export const PhpStormIcon = jetBrainsLogo({
  letters: "PS",
  a: {
    from: [56.329, -0.391],
    to: [2.874, 24.392],
    stops: [
      [0.16, "#D249FC"],
      [0.55, "#FF2D90"],
    ],
  },
  b: {
    from: [4.067, 4.326],
    to: [62.664, 62.923],
    stops: [
      [0.3, "#FF2D90"],
      [0.7, "#7256FF"],
    ],
  },
  accent: "#D249FC",
});
export const PyCharmIcon = jetBrainsLogo({
  letters: "PC",
  a: {
    from: [7.671, 64.393],
    to: [61.126, 39.609],
    stops: [
      [0.1, "#00D886"],
      [0.59, "#F0EB18"],
    ],
  },
  b: {
    from: [59.933, 59.676],
    to: [1.337, 1.08],
    stops: [
      [0.3, "#F0EB18"],
      [0.7, "#00C4F4"],
    ],
  },
  accent: "#00D886",
});
export const RiderIcon = jetBrainsLogo({
  letters: "RD",
  a: {
    from: [64.391, 56.329],
    to: [39.607, 2.874],
    stops: [
      [0.21, "#007DFE"],
      [0.55, "#FFB700"],
    ],
  },
  b: {
    from: [59.676, 4.067],
    to: [1.08, 62.663],
    stops: [
      [0.23, "#FFB700"],
      [0.73, "#FF0A67"],
    ],
  },
  accent: "#007DFE",
});
export const RubyMineIcon = jetBrainsLogo({
  letters: "RM",
  a: {
    from: [4.325, 59.932],
    to: [62.921, 1.337],
    stops: [
      [0.29, "#FF2358"],
      [0.75, "#7256FF"],
    ],
  },
  b: {
    from: [-0.391, 7.671],
    to: [24.393, 61.125],
    stops: [
      [0.29, "#FF8100"],
      [0.56, "#FF2358"],
    ],
  },
  accent: "#FF8100",
});
export const RustRoverIcon = jetBrainsLogo({
  letters: "RR",
  a: {
    from: [7.671, 64.393],
    to: [61.125, 39.609],
    stops: [
      [0.08, "#00D886"],
      [0.46, "#FFAB00"],
    ],
  },
  b: {
    from: [59.932, 59.676],
    to: [1.336, 1.08],
    stops: [
      [0.19, "#FFAB00"],
      [0.83, "#FF004C"],
    ],
  },
  accent: "#00D886",
});
export const WebStormIcon = jetBrainsLogo({
  letters: "WS",
  a: {
    from: [7.671, 64.392],
    to: [61.126, 39.609],
    stops: [
      [0.22, "#F0EB18"],
      [0.59, "#00C4F4"],
    ],
  },
  b: {
    from: [59.932, 59.676],
    to: [1.337, 1.079],
    stops: [
      [0.19, "#00C4F4"],
      [0.83, "#007DFE"],
    ],
  },
  accent: "#F0EB18",
});
