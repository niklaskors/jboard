import { spawn } from "node:child_process";

/** Open a URL in the default browser; `background` keeps it from taking focus where the OS allows (macOS). */
export function openUrl(url: string, { background = false } = {}): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", background ? ["-g", url] : [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
