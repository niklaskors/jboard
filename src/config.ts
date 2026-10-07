// Settings from ~/.config/jboard/config.json; an environment variable, where set, wins over the file.
// See the README for what each one means.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The config file: $XDG_CONFIG_HOME/jboard/config.json, by default ~/.config/jboard/config.json. */
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jboard", "config.json");

/** What the config file may hold, with the environment variable that overrides each. */
const SETTINGS = {
  server: "JIRA_SERVER",
  token: "JIRA_API_TOKEN",
  board: "JIRA_BOARD_ID",
  columns: "JBOARD_COLUMNS",
  theme: "JBOARD_THEME",
  ssoUrl: "JIRA_SSO_URL",
  bench: "JBOARD_BENCH",
  branch: "JBOARD_BRANCH",
  truecolor: "JBOARD_TRUECOLOR",
} as const;

type Setting = keyof typeof SETTINGS;

/** Why the config file can't be used, reported when jboard starts; "" when it is fine or there is none. */
export let CONFIG_ERROR = "";

function readConfig(): Partial<Record<Setting, string>> {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return {}; // no file: the environment only
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object of settings");
    const config: Partial<Record<Setting, string>> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!(name in SETTINGS)) throw new Error(`unknown setting "${name}", choose from: ${Object.keys(SETTINGS).join(", ")}`);
      // a list of columns, a number for the board, true for truecolor: all read as the environment would have them
      config[name as Setting] = Array.isArray(value) ? value.join(",") : value === true ? "1" : value === false ? "" : String(value);
    }
    return config;
  } catch (e) {
    CONFIG_ERROR = `${CONFIG_FILE}: ${(e as Error).message}`;
    return {};
  }
}

let config = readConfig();

/** A setting from the environment, else the config file; undefined when neither has it. */
export const setting = (name: Setting): string | undefined => process.env[SETTINGS[name]] ?? config[name];

export let SERVER = "";
export let TOKEN = "";
/** Opens Jira's SSO sign-in; set ssoUrl when login.jsp doesn't (e.g. <jira>/plugins/servlet/samlsso). */
export let SSO_URL = "";

function apply(): void {
  SERVER = (setting("server") ?? "").replace(/\/+$/, "");
  TOKEN = setting("token") ?? "";
  SSO_URL = setting("ssoUrl") || `${SERVER}/login.jsp?os_destination=${encodeURIComponent("/secure/Dashboard.jspa")}`;
}
apply();

/** Read the config file again, e.g. after setup wrote it. */
export function reloadConfig(): void {
  CONFIG_ERROR = "";
  config = readConfig();
  apply();
}

/** Save settings in the config file, keeping the others in it; only you can read it, since it holds the token. */
export function saveConfig(settings: Partial<Record<Setting, string>>): void {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    // none yet, or one setup replaces
  }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...saved, ...settings }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600); // also when it was there already
  reloadConfig();
}

export const boardUrl = (boardId: string) => `${SERVER}/secure/RapidBoard.jspa?rapidView=${boardId}`;
export const issueUrl = (key: string) => `${SERVER}/browse/${key}`;
