// Command line: options, help text and startup.

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { benchedIssues, listBenches } from "./bench.ts";
import { Board } from "./board.ts";
import { openUrl } from "./browser.ts";
import { boardUrl, CONFIG_ERROR, CONFIG_FILE, SERVER, setting, TOKEN } from "./config.ts";
import { JiraError } from "./jira/client.ts";
import { printBoard } from "./render/print.ts";
import { THEME_NAMES, useTheme } from "./render/theme.ts";
import { setup } from "./setup.ts";
import { Tui } from "./tui/app.ts";

const USAGE = `Usage: jboard [-m] [-a] [-b BOARD_ID] [--columns NAMES] [-w] [-p] [-t THEME] [--setup]
  -m, --mine     start with only my cards (assigned to me, or with a subtask of mine)
  -a, --all      show every card in the done column, not just the 5 latest
  -b, --board    board id, the rapidView=<id> in the board's URL (default: the config's board)
      --columns  the board's columns to show, comma separated, e.g. "To Do,In Progress,Done"
                 (default: the config's columns, else all); cards in other columns are left out
  -w, --web      open the board in the browser instead
  -p, --print    print the board once instead of the interactive view
                 (automatic when output is not a terminal)
  -t, --theme    night (default, dark), day (light terminals) or classic (16 colours);
                 or set it in the config. 24-bit colour is used when $COLORTERM says so
      --setup    ask for your Jira, token and board again and save them in the config
                 (also what happens on the first run, when there is no config yet)

Keys: h/j/k/l or arrows  move          enter/space  expand/collapse subtasks
      g/G                top/bottom    e            expand/collapse all
      o                  open the selected issue in the browser
      w                  open the whole board in the browser
      s                  change status of the selected story/subtask (type to filter)
      A                  assign the selected story/subtask (type to search, enter to assign)
      p                  set story points of the selected story (empty clears)
      c                  create subtasks under the selected story: one per line, ctrl+s to create
      b                  open the selected issue's bench (its own git worktree) in a new terminal tab,
                         making it in the default repo first; subtasks use their story's bench
      B                  the same, choosing the repo first
      M                  open the merge request of the selected issue's bench in the browser
      D                  remove one of the selected issue's benches, keeping or deleting its branch
                         (refused while it has uncommitted or unpushed work)
      m                  toggle mine   a            toggle all done cards
      r                  refresh       ctrl+c       quit
      ?                  show all keys

Config: ${CONFIG_FILE}, e.g.
  { "server": "https://jira.example.com/jira", "token": "...", "board": 123 }

  server     base URL of your Jira                                     (required)
  token      personal access token, sent as a bearer token             (required)
  board      board to show, the rapidView=<id> in the board's URL       (or use --board)
  columns    columns to show, a list or comma separated                (or use --columns)
  theme      night, day or classic                                     (or use --theme)
  ssoUrl     page that redoes your SSO sign-in when Jira suddenly refuses the token
             (default: <server>/login.jsp)
  bench      the bench command, for b and B (default: bench; see github.com/niklaskors/bench)
  branch     branch name for a new bench, from {type} (fix for bugs, else feat), {key} and
             {summary} (default: {type}/{key}-{summary})
  truecolor  true forces 24-bit colour

Each can also be set in the environment, which wins over the file: JIRA_SERVER, JIRA_API_TOKEN,
JIRA_BOARD_ID, JBOARD_COLUMNS, JBOARD_THEME, JIRA_SSO_URL, JBOARD_BENCH, JBOARD_BRANCH, JBOARD_TRUECOLOR.`;

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mine: { type: "boolean", short: "m" },
        all: { type: "boolean", short: "a" },
        board: { type: "string", short: "b" },
        columns: { type: "string" },
        web: { type: "boolean", short: "w" },
        print: { type: "boolean", short: "p" },
        theme: { type: "string", short: "t" },
        setup: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    console.error(`jboard: ${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  // the first run, without a config or the settings in the environment: set it up
  const firstRun = !existsSync(CONFIG_FILE) && !(SERVER && TOKEN);
  if (values.setup || (firstRun && process.stdin.isTTY)) {
    await setup();
    if (values.setup) return;
  } else if (firstRun) {
    throw new JiraError(`no config yet: run jboard in a terminal to set it up, or write ${CONFIG_FILE}`);
  }
  if (CONFIG_ERROR) {
    console.error(`jboard: ${CONFIG_ERROR}`);
    process.exit(2);
  }
  const themeName = values.theme ?? setting("theme") ?? "night";
  if (!useTheme(themeName)) {
    console.error(`jboard: unknown theme "${themeName}", choose from: ${THEME_NAMES.join(", ")}`);
    process.exit(2);
  }
  if (!SERVER || !TOKEN) throw new JiraError(`set "server" and "token" in ${CONFIG_FILE} (or JIRA_SERVER and JIRA_API_TOKEN)`);

  const boardId = values.board ?? setting("board");
  if (!boardId) throw new JiraError(`no board: set "board" in ${CONFIG_FILE} or pass --board <id> (the rapidView=<id> in the board's URL)`);
  if (values.web) {
    openUrl(boardUrl(boardId));
    return;
  }

  const columns = (values.columns ?? setting("columns") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const board = new Board(boardId, columns);
  await board.reload();
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    printBoard(board, !!values.mine, !!values.all, benchedIssues(await listBenches({ mrs: true, keys: board.keys() }), board.keys()));
  } else {
    new Tui(board, !!values.mine, !!values.all).start();
  }
}

/** Run jboard; Jira problems end it with a readable message instead of a stack trace. */
export function run(): void {
  main().catch((e: unknown) => {
    if (!(e instanceof JiraError)) throw e;
    console.error(`jboard: ${e.message}`);
    process.exit(1);
  });
}
