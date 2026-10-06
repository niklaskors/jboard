// Themes map style names (card, pill2, person3, ...) to terminal escape codes.

import { lineLen, type Line, type Style } from "./line.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const REVERSE = "\x1b[7m";
const UNDERLINE = "\x1b[4m";
const ACCENT_SLOTS = 12; // per-column style names (col3, pill3, ...) exist for this many columns

/**
 * The style slot of a board column: its index, except that the last column (done) always has the "done" slot,
 * so done is green however many columns the board shows (the backlog's one column isn't done). Styles are e.g. `col${slot}` and `pill${slot}`.
 */
export const columnSlot = (idx: number, count: number) => (idx === count - 1 && count > 1 ? "done" : String(idx));
/** Distinct colours for people; with this many or fewer on the board, everyone has their own. */
export const PEOPLE_SLOTS = 11;

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
  accents: string[]; // per board column: to do, in progress, in review, ...
  done: string; // the last column
  onAccent: string; // text on an accent-filled pill
  story: string; task: string; bug: string; epic: string;
  people: string[];
  me: string; points: string; pointsBg: string; track: string; info: string;
}

export interface Theme {
  cards: boolean; // tinted card blocks with an accent bar; false = classic reverse-video selection
  corners: string; // dialog corners: top-left, top-right, bottom-left, bottom-right
  icons: { story: string; task: string; bug: string; epic: string; other: string; dot: string;
    sprint: string; info: string; full: string; empty: string; bench: string; bell: string };
  codes: Record<string, string>; // style name -> escape codes
}

/** Dark: muted slate cards, warm accents. */
const NIGHT: Palette = {
  text: "#cdd6e0", muted: "#8b98a5", faint: "#5d6873",
  card: "#1d232b", cardSel: "#2e3743", panel: "#232a33", optSel: "#3a4656",
  accents: ["#8899aa", "#e0af4f", "#b48ef0", "#5aa2f0", "#e27aae", "#56c2c2"],
  done: "#5fb86a",
  onAccent: "#12161c",
  story: "#5fb86a", task: "#5aa2f0", bug: "#ec6a5e", epic: "#b48ef0",
  // around the colour wheel, none close to `me`; neighbours differ, as a clash moves someone to the next one
  people: ["#ff7a7a", "#e9c46a", "#6fd08c", "#7a9bff", "#e48ae0", "#ffa257", "#c3e88d", "#4fd6be", "#c099ff", "#ff8fc6",
    "#d7b98e"],
  me: "#7dcfff", points: "#a9d4ff", pointsBg: "#22344a", track: "#38424e", info: "#5aa2f0",
};

/** Light: soft grey cards for white terminals. */
const DAY: Palette = {
  text: "#1f2328", muted: "#59636e", faint: "#8c959f",
  card: "#f2f4f7", cardSel: "#dbe5f2", panel: "#f6f8fa", optSel: "#cfe0f7",
  accents: ["#6e7781", "#b07a00", "#8250df", "#0969da", "#bf3989", "#0a6c74"],
  done: "#1a7f37",
  onAccent: "#ffffff",
  story: "#1a7f37", task: "#0969da", bug: "#cf222e", epic: "#8250df",
  people: ["#c62828", "#9a6700", "#1a7f37", "#3f3fbf", "#a0289a", "#c45a00", "#5a7d00", "#00796b", "#7b3fd0", "#c2185b",
    "#8d5a3b"],
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
    progress: fg(p.done), track: fg(p.track), empty: ITALIC + fg(p.faint),
    italic: ITALIC, code: fg(p.points), link: UNDERLINE + fg(p.info), // descriptions
    shade: fg(p.track), shadebg: bg(p.card) + fg(p.track), // the board behind a dialog
    alert: BOLD + bg(p.bug) + fg(p.onAccent), // notifications waiting
  };
  const slots: [string, string][] = Array.from({ length: ACCENT_SLOTS }, (_, i) => [String(i), p.accents[i % p.accents.length]]);
  for (const [i, accent] of [...slots, ["done", p.done]]) {
    Object.assign(codes, {
      [`col${i}`]: BOLD + fg(accent), [`fg${i}`]: fg(accent), [`bar${i}`]: fg(accent),
      [`rule${i}`]: fg(p.track), [`pill${i}`]: BOLD + bg(accent) + fg(p.onAccent),
    });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = fg(p.people[i % p.people.length]);
  return {
    cards: true, corners: "╭╮╰╯", codes,
    icons: { story: "●", task: "■", bug: "▲", epic: "◆", other: "•", dot: "●", sprint: "◆", info: "●", full: "━", empty: "━", bench: "⎇", bell: "🔔" },
  };
}

/** The original look: the 16 basic terminal colours, reverse video for selection. */
function classicTheme(): Theme {
  const cols = ["\x1b[39m", "\x1b[33m", "\x1b[35m", "\x1b[36m", "\x1b[34m"];
  const green = "\x1b[32m";
  const codes: Record<string, string> = {
    text: "", dim: DIM, name: DIM, bold: BOLD, title: BOLD, me: `${BOLD}\x1b[36m`,
    story: `${BOLD}\x1b[32m`, task: `${BOLD}\x1b[34m`, bug: `${BOLD}\x1b[31m`, epic: `${BOLD}\x1b[36m`,
    points: "\x1b[36m", warn: `${BOLD}\x1b[31m`, accent: BOLD, rev: REVERSE, panel: "", box: BOLD, boxtitle: BOLD,
    key: REVERSE, keylabel: DIM, msg: "", progress: "\x1b[32m", track: DIM, empty: DIM,
    italic: ITALIC, code: "\x1b[36m", link: UNDERLINE,
    shade: DIM, shadebg: DIM, alert: `${BOLD}\x1b[31m${REVERSE}`,
  };
  const slots: [string, string][] = Array.from({ length: ACCENT_SLOTS }, (_, i) => [String(i), cols[i % cols.length]]);
  for (const [i, c] of [...slots, ["done", green]]) {
    Object.assign(codes, { [`col${i}`]: BOLD + c, [`fg${i}`]: c, [`bar${i}`]: c, [`rule${i}`]: c, [`pill${i}`]: BOLD + c + REVERSE });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = DIM;
  return {
    cards: false, corners: "┌┐└┘", codes,
    icons: { story: "S", task: "T", bug: "B", epic: "E", other: "•", dot: "", sprint: "", info: "", full: "█", empty: "░", bench: "*", bell: "!" },
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

/** A line greyed out, keeping only whether its parts have a background: the board behind a dialog. */
export function shade(line: Line): Line {
  return line.map(([text, style]) => [text, /\x1b\[(48;|7m)/.test(styleCode(style)) ? "shadebg" : "shade"]);
}

/** Render a line, padded with spaces to `width`. */
export function ansi(line: Line, width = 0): string {
  const out = line.map(([text, style]) => (style && text ? `${styleCode(style)}${text}${RESET}` : text)).join("");
  return out + " ".repeat(Math.max(0, width - lineLen(line)));
}
