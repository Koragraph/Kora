import type { ProjectBadgeColor } from "@kora/contracts";

type ProjectIconColor = {
  readonly swatchClassName: string;
  readonly className: string;
  readonly label: string;
  readonly value: ProjectBadgeColor;
};

// Full literal class names so Tailwind's static scanner picks them up.
export const PROJECT_ICON_COLORS: ReadonlyArray<ProjectIconColor> = [
  {
    swatchClassName: "bg-gray-500",
    className: "text-gray-600 dark:text-gray-400",
    label: "Gray",
    value: "gray",
  },
  {
    swatchClassName: "bg-red-500",
    className: "text-red-600 dark:text-red-400",
    label: "Red",
    value: "red",
  },
  {
    swatchClassName: "bg-orange-500",
    className: "text-orange-600 dark:text-orange-400",
    label: "Orange",
    value: "orange",
  },
  {
    swatchClassName: "bg-amber-500",
    className: "text-amber-600 dark:text-amber-400",
    label: "Amber",
    value: "amber",
  },
  {
    swatchClassName: "bg-yellow-500",
    className: "text-yellow-600 dark:text-yellow-400",
    label: "Yellow",
    value: "yellow",
  },
  {
    swatchClassName: "bg-lime-500",
    className: "text-lime-600 dark:text-lime-400",
    label: "Lime",
    value: "lime",
  },
  {
    swatchClassName: "bg-green-500",
    className: "text-green-600 dark:text-green-400",
    label: "Green",
    value: "green",
  },
  {
    swatchClassName: "bg-emerald-500",
    className: "text-emerald-600 dark:text-emerald-400",
    label: "Emerald",
    value: "emerald",
  },
  {
    swatchClassName: "bg-teal-500",
    className: "text-teal-600 dark:text-teal-400",
    label: "Teal",
    value: "teal",
  },
  {
    swatchClassName: "bg-cyan-500",
    className: "text-cyan-600 dark:text-cyan-400",
    label: "Cyan",
    value: "cyan",
  },
  {
    swatchClassName: "bg-sky-500",
    className: "text-sky-600 dark:text-sky-400",
    label: "Sky",
    value: "sky",
  },
  {
    swatchClassName: "bg-blue-500",
    className: "text-blue-600 dark:text-blue-400",
    label: "Blue",
    value: "blue",
  },
  {
    swatchClassName: "bg-indigo-500",
    className: "text-indigo-600 dark:text-indigo-400",
    label: "Indigo",
    value: "indigo",
  },
  {
    swatchClassName: "bg-violet-500",
    className: "text-violet-600 dark:text-violet-400",
    label: "Violet",
    value: "violet",
  },
  {
    swatchClassName: "bg-purple-500",
    className: "text-purple-600 dark:text-purple-400",
    label: "Purple",
    value: "purple",
  },
  {
    swatchClassName: "bg-fuchsia-500",
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    label: "Fuchsia",
    value: "fuchsia",
  },
  {
    swatchClassName: "bg-pink-500",
    className: "text-pink-600 dark:text-pink-400",
    label: "Pink",
    value: "pink",
  },
  {
    swatchClassName: "bg-rose-500",
    className: "text-rose-600 dark:text-rose-400",
    label: "Rose",
    value: "rose",
  },
];

const CLASS_BY_COLOR = new Map(PROJECT_ICON_COLORS.map((ch) => [ch.value, ch.className] as const));

export function projectIconColorClassName(hue: ProjectBadgeColor): string {
  return CLASS_BY_COLOR.get(hue) ?? "";
}
