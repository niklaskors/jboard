// Themes map style names (card, pill2, person3, ...) to terminal escape codes.

import { lineLen, type Line, type Style } from "./line.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const REVERSE = "\x1b[7m";
const ACCENT_SLOTS = 12; // per-column style names (col3, pill3, ...) exist for this many columns
export const PEOPLE_SLOTS = 8;

/** 24-bit colour where the terminal supports it, otherwise the nearest of the 256 xterm colours. */
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "")
  || ["iTerm.app", "WezTerm", "ghostty", "vscode"].includes(process.env.TERM_PROGRAM ?? "")
  || process.env.JBOARD_TRUECOLOR === "1";

function to256(r: number, g: number, b: number): number {
  const steps = [0, 95, 135, 175, 215, 255];
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cubeDist = (steps[cr] - r) ** 2 + (steps[cg] - g) ** 2 + (steps[cb] - b) ** 2;
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + gray * 10;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + gray : 16 + 36 * cr + 6 * cg + cb;
}

function rgb(hex: string, layer: 38 | 48): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return TRUECOLOR ? `\x1b[${layer};2;${r};${g};${b}m` : `\x1b[${layer};5;${to256(r, g, b)}m`;
}
const fg = (hex: string) => rgb(hex, 38);
const bg = (hex: string) => rgb(hex, 48);

interface Palette {
  text: string; muted: string; faint: string; // foregrounds
  card: string; cardSel: string; panel: string; optSel: string; // backgrounds
  accents: string[]; // per board column: to do, in progress, in review, done, ...
  onAccent: string; // text on an accent-filled pill
  story: string; task: string; bug: string; epic: string;
  people: string[];
  me: string; points: string; pointsBg: string; track: string; info: string;
}

export interface Theme {
  cards: boolean; // tinted card blocks with an accent bar; false = classic reverse-video selection
  corners: string; // dialog corners: top-left, top-right, bottom-left, bottom-right
  icons: { story: string; task: string; bug: string; epic: string; other: string; dot: string;
    sprint: string; info: string; full: string; empty: string; bench: string };
  codes: Record<string, string>; // style name -> escape codes
}

/** Dark: muted slate cards, warm accents. */
const NIGHT: Palette = {
  text: "#cdd6e0", muted: "#8b98a5", faint: "#5d6873",
  card: "#1d232b", cardSel: "#2e3743", panel: "#232a33", optSel: "#3a4656",
  accents: ["#8899aa", "#e0af4f", "#b48ef0", "#5fb86a", "#5aa2f0", "#e27aae"],
  onAccent: "#12161c",
  story: "#5fb86a", task: "#5aa2f0", bug: "#ec6a5e", epic: "#b48ef0",
  people: ["#f2a65a", "#6fb8ff", "#d8b4fe", "#8fd694", "#f7768e", "#7dcfff", "#e9c46a", "#f5a3c7"],
  me: "#7dcfff", points: "#a9d4ff", pointsBg: "#22344a", track: "#38424e", info: "#5aa2f0",
};

/** Light: soft grey cards for white terminals. */
const DAY: Palette = {
  text: "#1f2328", muted: "#59636e", faint: "#8c959f",
  card: "#f2f4f7", cardSel: "#dbe5f2", panel: "#f6f8fa", optSel: "#cfe0f7",
  accents: ["#6e7781", "#b07a00", "#8250df", "#1a7f37", "#0969da", "#bf3989"],
  onAccent: "#ffffff",
  story: "#1a7f37", task: "#0969da", bug: "#cf222e", epic: "#8250df",
  people: ["#bc4c00", "#0550ae", "#8250df", "#116329", "#a40e26", "#0a6c74", "#7d4e00", "#99286e"],
  me: "#0969da", points: "#0550ae", pointsBg: "#ddf4ff", track: "#d0d7de", info: "#0969da",
};

function paletteTheme(p: Palette): Theme {
  const codes: Record<string, string> = {
    text: fg(p.text), dim: fg(p.faint), name: fg(p.muted), bold: BOLD + fg(p.text), title: BOLD + fg(p.text),
    me: BOLD + fg(p.me), story: fg(p.story), task: fg(p.task), bug: fg(p.bug), epic: fg(p.epic),
    points: fg(p.points) + bg(p.pointsBg), warn: BOLD + fg(p.bug), accent: BOLD + fg(p.info),
    card: bg(p.card) + fg(p.text), cardsel: bg(p.cardSel) + fg(p.text),
    rev: BOLD + bg(p.optSel) + fg(p.text), panel: bg(p.panel) + fg(p.text),
    box: bg(p.panel) + fg(p.muted), boxtitle: BOLD + bg(p.panel) + fg(p.text),
    key: BOLD + bg(p.cardSel) + fg(p.text), keylabel: fg(p.muted), msg: BOLD + fg(p.text),
    progress: fg(p.accents[3 % p.accents.length]), track: fg(p.track), empty: ITALIC + fg(p.faint),
  };
  for (let i = 0; i < ACCENT_SLOTS; i++) {
    const accent = p.accents[i % p.accents.length];
    Object.assign(codes, {
      [`col${i}`]: BOLD + fg(accent), [`fg${i}`]: fg(accent), [`bar${i}`]: fg(accent),
      [`rule${i}`]: fg(p.track), [`pill${i}`]: BOLD + bg(accent) + fg(p.onAccent),
    });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = fg(p.people[i % p.people.length]);
  return {
    cards: true, corners: "╭╮╰╯", codes,
    icons: { story: "●", task: "■", bug: "▲", epic: "◆", other: "•", dot: "●", sprint: "◆", info: "●", full: "━", empty: "━", bench: "⎇" },
  };
}

/** The original look: the 16 basic terminal colours, reverse video for selection. */
function classicTheme(): Theme {
  const cols = ["\x1b[39m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[36m", "\x1b[34m"];
  const codes: Record<string, string> = {
    text: "", dim: DIM, name: DIM, bold: BOLD, title: BOLD, me: `${BOLD}\x1b[36m`,
    story: `${BOLD}\x1b[32m`, task: `${BOLD}\x1b[34m`, bug: `${BOLD}\x1b[31m`, epic: `${BOLD}\x1b[36m`,
    points: "\x1b[36m", warn: `${BOLD}\x1b[31m`, accent: BOLD, rev: REVERSE, panel: "", box: BOLD, boxtitle: BOLD,
    key: REVERSE, keylabel: DIM, msg: "", progress: "\x1b[32m", track: DIM, empty: DIM,
  };
  for (let i = 0; i < ACCENT_SLOTS; i++) {
    const c = cols[i % cols.length];
    Object.assign(codes, { [`col${i}`]: BOLD + c, [`fg${i}`]: c, [`bar${i}`]: c, [`rule${i}`]: c, [`pill${i}`]: BOLD + c + REVERSE });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = DIM;
  return {
    cards: false, corners: "┌┐└┘", codes,
    icons: { story: "S", task: "T", bug: "B", epic: "E", other: "•", dot: "", sprint: "", info: "", full: "█", empty: "░", bench: "*" },
  };
}

const THEMES: Record<string, () => Theme> = { night: () => paletteTheme(NIGHT), day: () => paletteTheme(DAY), classic: classicTheme };
export const THEME_NAMES = Object.keys(THEMES);

/** The theme in use; importers see the switch made by useTheme(). */
export let theme: Theme = THEMES.night();

export function useTheme(name: string): boolean {
  const make = THEMES[name];
  if (make) theme = make();
  return !!make;
}

function styleCode(style: Style): string {
  return style ? style.split("+").map((s) => theme.codes[s] ?? "").join("") : "";
}

/** Render a line, padded with spaces to `width`. */
export function ansi(line: Line, width = 0): string {
  const out = line.map(([text, style]) => (style && text ? `${styleCode(style)}${text}${RESET}` : text)).join("");
  return out + " ".repeat(Math.max(0, width - lineLen(line)));
}
