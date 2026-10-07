# jboard

Your active Jira sprint as an interactive kanban board in the terminal.

![jboard showing a sprint board in the terminal](docs/screenshot.png)

- **The board you know**: the columns, statuses and story points of your Jira board, one card per story with its subtasks folded underneath
- **Work without the browser**: change status, assign people, set story points, read and edit descriptions, create stories, tasks, bugs and subtasks, and plan the backlog into sprints from the keyboard
- **Start on an issue in one key**: `b` opens the issue's own git worktree in a new terminal tab, made in seconds by
  [bench](https://github.com/niklaskors/bench)
- **No build, no dependencies**: TypeScript that Node runs directly, so there is no build step and no `npm install` needed to use it

## Requirements

- **Node.js 22.18 or newer** (runs TypeScript directly)
- **Jira Server or Data Center** with a [personal access token](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html).
  Jira Cloud is not supported yet: it uses basic auth with an API token instead of bearer tokens.

## Install

```sh
git clone https://github.com/niklaskors/jboard.git
ln -s "$PWD/jboard/bin/jboard.ts" ~/.local/bin/jboard   # any directory on your PATH
```

The link must point at `bin/jboard.ts` inside the clone (not a copy of it): it loads the rest of the code from `src/`.
To update, `git pull` in the clone.

The first time you run `jboard`, it asks for your Jira's URL, a personal access token (in Jira: your profile →
Personal Access Tokens) and your board, checks them with Jira and saves them in `~/.config/jboard/config.json`
(readable only by you, since it holds the token). `jboard --setup` asks again.

## Usage

```sh
jboard              # interactive board for the active sprint
jboard -m           # only cards assigned to me (or with a subtask of mine)
jboard -p           # print the board once, e.g. to pipe it somewhere
jboard -w           # open the board in the browser
jboard -t day       # light theme
jboard --columns "To Do,Done"   # only these columns of the board
jboard --setup      # change your Jira, token or board
jboard -h           # all options
```

### Keys

| Key | Action |
|---|---|
| `h` `j` `k` `l` / arrows | Move between columns and cards |
| `g` / `G` | Top / bottom of the column |
| `Ctrl+D` / `Ctrl+U` | Half a screen down / up (also `PgDn` / `PgUp`) |
| `/` | Search the tab by key or summary, jumping to matches as you type: `Ctrl+N` / `Ctrl+P` next / previous, `⏎` keeps the match, `Esc` goes back. After `⏎`, `Ctrl+N` / `Ctrl+P` keep going through the matches |
| `Enter` / `Space` | Show or hide a story's subtasks |
| `e` | Show or hide all subtasks |
| `s` | Change status (the transitions your workflow allows) |
| `A` | Assign: your team first, type to search everyone |
| `p` | Set story points (empty clears them) |
| `c` | Create subtasks: type or paste a list, one per line, `Ctrl+S` to create |
| `Tab` / `Shift+Tab` | Next / previous tab: the open sprints (active first, then the future ones) and the backlog, shown as tabs on top. Every key works in each |
| `S` | Move the story (with its subtasks) to another sprint or to the backlog |
| `C` | Create a story, task or bug: `←`/`→` type, the summary, `↑`/`↓` sprint, `Ctrl+E` for a description. It is created in the backlog and stays there unless you choose a sprint, which it is then moved to |
| `d` | Show the description, rendered from Jira's wiki markup (or Markdown): `j`/`k` scroll, `h`/`l` scroll code sideways, `r` shows it as written, `e` edits it in `$VISUAL` / `$EDITOR` and saves it when you quit the editor |
| `b` | Open the issue's bench in a new terminal tab, making it first in the default repo (see [Benches](#benches)). On a story with subtasks, choose the story or one of its subtasks first |
| `B` | The same, choosing the repo first |
| `F` | Make a new bench whose branch starts from another branch (e.g. its story's), choosing the repo (when there are several) and the branch |
| `M` | Open the merge request (or pull request) of the issue's bench in the browser |
| `D` | Remove one of the issue's benches, keeping or deleting its local branch |
| `n` | Notifications: issues whose merge request was merged, to move to done in one key (see [Notifications](#notifications)) |
| `o` / `w` | Open the selected issue / the board in the browser |
| `m` | Toggle "only mine" |
| `v` | Cards or a compact list, a line per issue, in every tab (until you press it, only the backlog is a list) |
| `a` | Show all done cards instead of the latest 5 |
| `r` | Reload from Jira |
| `?` | Show all keys |
| `Ctrl+C` | Quit |

Dialogs filter as you type; `Esc` closes them without changing anything.

## Configuration

Settings live in `~/.config/jboard/config.json` (or `$XDG_CONFIG_HOME/jboard/config.json`), which setup writes:

```json
{
  "server": "https://jira.example.com/jira",
  "token": "...",
  "board": 123,
  "columns": ["To Do", "In Progress", "Done"],
  "theme": "day"
}
```

Each setting can also come from an environment variable, which wins over the file, e.g. for one run:
`JIRA_BOARD_ID=456 jboard`.

| Setting | Variable | Meaning |
|---|---|---|
| `server` | `JIRA_SERVER` | Base URL of your Jira (required) |
| `token` | `JIRA_API_TOKEN` | Personal access token, sent as a bearer token (required) |
| `board` | `JIRA_BOARD_ID` | Board to show, the `rapidView=<id>` in its URL; or pass `--board <id>` |
| `columns` | `JBOARD_COLUMNS` | The board's columns to show, a list or comma separated, e.g. `To Do,In Progress,Done` (default: all); or pass `--columns`. Cards in other columns are left out |
| `theme` | `JBOARD_THEME` | `night` (default), `day` or `classic` |
| `ssoUrl` | `JIRA_SSO_URL` | Page that redoes your single sign-on, see below (default: `<server>/login.jsp`) |
| `bench` | `JBOARD_BENCH` | The bench command for `b` and `B` (default `bench`) |
| `branch` | `JBOARD_BRANCH` | Branch name for a new bench, from `{type}` (`fix` for bugs, else `feat`), `{key}` and `{summary}` (default `{type}/{key}-{summary}`) |
| `truecolor` | `JBOARD_TRUECOLOR` | `true` (or `1`) forces 24-bit colour if your terminal supports it but doesn't say so |

The editor for descriptions is `$VISUAL` or `$EDITOR` (default `nvim` if installed, else `vi`); it may include
arguments, e.g. `code -w`.

Story points come from the field your board estimates with, so the totals match the web board.

### Single sign-on

Some Jira setups with SAML single sign-on stop accepting a valid token until you sign in again in the browser
(the API then answers `403 Client must have sufficient permissions`). jboard handles this itself:
it opens `ssoUrl` in your browser in the background, waits until the token works again, and carries on.
If `login.jsp` doesn't start your sign-in, point `ssoUrl` at the page that does,
for example `<server>/plugins/servlet/samlsso` for the resolution SAML SSO app.

### Benches

`b` and `B` hand the selected issue to [bench](https://github.com/niklaskors/bench), a separate tool that gives a
branch its own git worktree with packages installed, from a pool of ready ones. Install it and add your repos
(`bench add <path>`) to use them; jboard works the same without it.

- An issue's bench is the one whose branch contains its key; otherwise `b` makes one, named after the issue
  (`feat/PROJ-123-short-summary`, or `fix/…` for bugs; see `branch` under [Configuration](#configuration))
- `b` on a subtask is for the subtask itself; on a story with subtasks it asks whether the bench is for the story or
  one of its subtasks (✓ marks those with a bench). `M` and `D` on a subtask without a bench of its own use its story's
- `B` picks the repo, so a story that needs changes in two repos can have a bench in each; ✓ marks where it has one
- `F` makes the new branch from one you choose instead of the repo's base: the story's branches come first (for a
  subtask, to build on its story), then those with a bench, then the rest, newest first. Typing filters. It needs
  bench's `branches` command, and only makes new branches: an issue whose branch exists already opens with `b`
- `D` removes a bench; bench refuses while it has uncommitted changes or commits that aren't pushed
- Cards with a bench are marked with ⎇, followed by its merge request (e.g. `⎇ !123`) once bench has looked it up
  (with glab for GitLab, gh for GitHub), coloured by state: open, draft, merged or closed; `M` opens it
- Removing a bench keeps its merge request: the card still shows it (without ⎇) and `M` still opens it.
  `b` makes a bench on the same branch again
- The tab opens however bench is set up to open tabs (its `"tab"` and `"command"` settings), titled with the issue's
  key and summary (with oh-my-zsh, its automatic title is turned off in that tab so the title stays)
- When git or ssh needs something while bench runs, such as your SSH key's passphrase or whether to trust a host,
  jboard asks it on the board. A passphrase is hidden while you type it, asked once even when git connects a few
  times, and kept in memory (never on disk) until jboard quits; a wrong one is asked again. To not be asked at all,
  keep it in your SSH agent, e.g. on macOS with `UseKeychain yes` and `AddKeysToAgent yes` in `~/.ssh/config`

### Notifications

When the merge request of an issue's bench has been merged but the issue isn't in the last (done) column yet,
jboard notifies you: the status line says so and the bell top right shows how many (`🔔 2`). `n` lists them, each with the
suggested action of moving the issue to done:

- `⏎` moves it to done (the workflow step into the last column, preferably one called Done or Resolved)
- `x` dismisses it, `o` opens the merge request
- Handled notifications are remembered in `~/.local/state/jboard/handled.json`, so each comes up once
- Merge requests are looked up when the board starts, on `r`, and every 30 minutes while it is open
- Only merge requests bench knows about count (see [Benches](#benches)); an issue with another merge request
  still open is left alone

### Errors

Failed requests are logged with their response headers to `~/.cache/jboard/errors.log`.

## Development

```sh
npm install      # TypeScript, Node types and Vitest, only needed for checking and testing
npm run check    # strict type check
npm test         # integration tests
```

The tests run jboard against stand-ins: a small in-memory Jira (`test/fakes/jira.ts`) that jboard's real HTTP
client talks to, a fake `bench` (`test/fakes/bench.mjs`), and a browser and an editor that only record what they
were asked to do. `test/cli.test.ts` runs the `jboard` command as a separate process; the `tui-*` tests drive the
interactive board with key presses (`test/tui.ts`) and read back what it draws as plain text.

Node only strips types, so jboard can only use erasable TypeScript syntax (no enums, namespaces or parameter properties)
and imports must name the `.ts` file; `tsconfig.json` enforces both.

### Project layout

```
bin/jboard.ts          entry point
bin/askpass.ts         run by git and ssh to ask a question, which it hands to jboard
src/cli.ts             options, help text, startup
src/config.ts          settings from the config file and the environment
src/setup.ts           the first run's setup (and --setup): Jira, token and board
src/askpass.ts         questions from git and ssh while bench runs, asked on the board (with bin/askpass.ts)
src/browser.ts         opening URLs on macOS, Linux and Windows
src/bench.ts           running the bench tool: listing, naming and opening benches
src/notify.ts          notifications: merged merge requests of issues that aren't done
src/board.ts           the sprint or the backlog: columns, cards with their subtasks, story points
src/jira/client.ts     HTTP: bearer token, retries, error log, SSO re-sign-in
src/jira/api.ts        Jira operations: transitions, assigning, fields, bulk-creating subtasks
src/jira/types.ts      the Jira data jboard uses
src/render/line.ts     styled text lines: wrapping, fitting, overlaying
src/render/theme.ts    the night, day and classic themes
src/render/layout.ts   cards, column headers and the sprint header
src/render/print.ts    the printed board (-p)
src/render/markup.ts   descriptions: Jira wiki markup and Markdown as styled lines
src/tui/app.ts         the interactive board: navigation, drawing, keys
src/tui/dialog.ts      the dialog interface and box drawing
src/tui/picker.ts      filter-as-you-type list used by assign and status
src/tui/assign.ts      A: assign
src/tui/status.ts      s: change status
src/tui/points.ts      p: story points
src/tui/description.ts d: show and edit the description
src/tui/notifications.ts  n: notifications
src/tui/search.ts      /: search
src/tui/prompt.ts      a question from git or ssh, e.g. a passphrase
src/tui/subtasks.ts    c: create subtasks
src/tui/create.ts      C: create a story, task or bug
src/tui/sprint.ts      S: move to a sprint or the backlog
src/tui/bench.ts       b and B: open a bench
```

A new dialog implements `Dialog` (`draw` and `key`) and gets a `DialogHost` to show messages and run Jira changes;
`src/tui/points.ts` is the smallest example.

## License

[MIT](LICENSE)
