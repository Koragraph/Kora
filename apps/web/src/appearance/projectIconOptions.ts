import { iconNames, type IconName } from "lucide-react/dynamic";

export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_ICONS =
  "folder-code code-2 terminal globe-2 server database bot sparkles smartphone monitor cloud-cog package book-open flask-conical shield-check rocket gamepad-2 music image shopping-bag git-branch workflow wrench layers-3".split(
    " ",
  ) as unknown as ReadonlyArray<IconName>;

const MAX_RESULTS = 60;

const EMOJI_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["💻", "Computer"],
  ["🛠️", "Tools"],
  ["🚀", "Rocket"],
  ["🤖", "Robot"],
  ["✨", "Sparkles"],
  ["⚡", "Lightning"],
  ["🌐", "Web"],
  ["📱", "Mobile"],
  ["🖥️", "Desktop"],
  ["⌨️", "Keyboard"],
  ["⚙️", "Gear"],
  ["🗄️", "Database"],
  ["☁️", "Cloud"],
  ["📦", "Package"],
  ["📚", "Books"],
  ["🧪", "Test tube"],
  ["🔒", "Lock"],
  ["🎮", "Game"],
  ["🎵", "Music"],
  ["🎬", "Movie"],
  ["🖼️", "Picture"],
  ["🛍️", "Shopping"],
  ["🔥", "Fire"],
  ["💡", "Idea"],
  ["🧩", "Puzzle"],
  ["📊", "Chart"],
  ["🧠", "Brain"],
  ["🦄", "Unicorn"],
  ["🐙", "Octopus"],
  ["🌱", "Seedling"],
];

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> =
  EMOJI_TABLE.map(([emoji, label]) => ({ emoji, label }));

export function filterProjectIconNames(query: string): ReadonlyArray<IconName> {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "-");
  if (!needle) return POPULAR_ICONS;
  return iconNames.filter((name) => name.includes(needle)).slice(0, MAX_RESULTS);
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const KEYCAP = /^[#*0-9]️?⃣$/u;

export function firstEmoji(val: string): string | null {
  const str = val.trim();
  if (!str) return null;
  const head = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(str)
    [Symbol.iterator]()
    .next().value?.segment;
  if (!head) return null;
  return PICTOGRAPHIC.test(head) || FLAG.test(head) || KEYCAP.test(head) ? head : null;
}
