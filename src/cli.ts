// Command line: options, help text and startup.

import { parseArgs } from "node:util";
import { benchedIssues, listBenches } from "./bench.ts";
import { Board } from "./board.ts";
import { openUrl } from "./browser.ts";
import { boardUrl, SERVER, TOKEN } from "./config.ts";
import { JiraError } from "./jira/client.ts";
import { printBoard } from "./render/print.ts";
import { THEME_NAMES, useTheme } from "./render/theme.ts";
import { Tui } from "./tui/app.ts";

const USAGE = `Usage: jboard [-m] [-a] [-b BOARD_ID] [--columns NAMES] [-w] [-p] [-t THEME]
  -m, --mine     start with only my cards (assigned to me, or with a subtask of mine)
  -a, --all      show every card in the done column, not just the 5 latest
  -b, --board    board id, the rapidView=<id> in the board's URL (default: $JIRA_BOARD_ID)
      --columns  the board's columns to show, comma separated, e.g. "To Do,In Progress,Done"
                 (default: $JBOARD_COLUMNS, else all); cards in other columns are left out
  -w, --web      open the board in the browser instead
  -p, --print    print the board once instead of the interactive view
                 (automatic when output is not a terminal)
  -t, --theme    night (default, dark), day (light terminals) or classic (16 colours);
                 or set $JBOARD_THEME. 24-bit colour is used when $COLORTERM says so

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

Environment:
  JIRA_SERVER     base URL, e.g. https://jira.example.com/jira            (required)
  JIRA_API_TOKEN  personal access token, sent as a bearer token           (required)
  JIRA_BOARD_ID   board to show, the rapidView=<id> in the board's URL     (or use --board)
  JBOARD_COLUMNS  columns to show, comma separated                        (or use --columns)
  JIRA_SSO_URL    page that redoes your SSO sign-in when Jira suddenly refuses the token
                  (default: $JIRA_SERVER/login.jsp)
  JBOARD_THEME    night, day or classic
  JBOARD_BENCH    the bench command, for b and B (default: bench; see github.com/niklaskors/bench)
  JBOARD_BRANCH   branch name for a new bench, from {type} (fix for bugs, else feat), {key} and
                  {summary} (default: {type}/{key}-{summary})`;

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
  const themeName = values.theme ?? process.env.JBOARD_THEME ?? "night";
  if (!useTheme(themeName)) {
    console.error(`jboard: unknown theme "${themeName}", choose from: ${THEME_NAMES.join(", ")}`);
    process.exit(2);
  }
  if (!SERVER || !TOKEN) throw new JiraError("JIRA_SERVER and JIRA_API_TOKEN must be set");

  const boardId = values.board ?? process.env.JIRA_BOARD_ID;
  if (!boardId) throw new JiraError("no board: set JIRA_BOARD_ID or pass --board <id> (the rapidView=<id> in the board's URL)");
  if (values.web) {
    openUrl(boardUrl(boardId));
    return;
  }

  const columns = (values.columns ?? process.env.JBOARD_COLUMNS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
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
