# PIRL CLI user guide

This guide covers everything after installation. For requirements and installation, see the
[README](../README.md).

- [Commands](#commands)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Attaching files with `@`](#attaching-files-with-)
- [How a run works](#how-a-run-works)
- [Usage and limits](#usage-and-limits)
- [Settings](#settings)
- [Framework updates](#framework-updates)
- [Where your data lives](#where-your-data-lives)
- [Updating PIRL](#updating-pirl)

The interface is in Vietnamese or English, chosen in `/settings`; agents reply in the language of your request.

## Commands

| Command | Description |
| --- | --- |
| `/pirl-plan <request>` | Create or adjust a Plan |
| `/pirl-implement <request>` | Implement a task of a Plan, or fix it according to a review report |
| `/pirl-review <request>` | Review the implementation of a task |
| `/resume` | Continue a stopped run, chosen from a list |
| `/plans` | Browse the Plans, tasks and review reports of this repository |
| `/records` | Browse the framework's self-evaluation records |
| `/framework` | Framework version, local improvements and updates |
| `/settings` | Language, models, reasoning effort, mouse, appearance, parallel roles |
| `/doctor` | Check Claude Code, Python, Git and the Hub |
| `/copy` | Copy PIRL's latest reply |
| `/clear` | Clear the chat and start a new conversation |
| `/help` | Commands and keyboard shortcuts |
| `/exit` | Quit |

Text typed without a `/` is a question, a standalone task or framework maintenance. When it asks for a layer,
PIRL suggests the matching command instead of running it.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Enter | Send |
| Shift+Enter, Ctrl+J | New line in the input |
| Tab | Complete the selected command |
| ↑ / ↓ | Choose a suggestion or an answer; otherwise scroll the chat |
| Ctrl+P / Ctrl+N | Previous / next sent message |
| PgUp / PgDn, mouse wheel | Scroll the chat or the open panel |
| `@` | Attach a file or folder |
| Ctrl+V | Paste |
| Esc | Clear the input, close a panel, or stop the running run |
| Ctrl+C | Stop the running run; quit when nothing runs |

### Selecting and copying text

Drag with the mouse to select text in the chat or an open panel; no Shift key is needed. While you hold the
button, turn the wheel or move the pointer past the top or bottom edge, and the view scrolls on with the selection,
so a selection can be longer than the screen. Release the button to copy the selection to the clipboard; the status
line confirms it. A click clears the selection, and the right button pastes into the input.

`/copy` copies the whole latest reply. To let the terminal select text instead, set **Mouse** to "Để terminal xử lý"
in `/settings`; its selection is then limited to what is on screen.

## Attaching files with `@`

Type `@` to pick a file or folder of the target repository. The list filters as you type and follows
`.gitignore`; Tab or Enter on a folder opens it, and Enter on the open folder attaches the whole folder. Paths can
also be typed: `@src/orders/cancel.ts`, `@docs/`, `@~/specs/api.md`, `@"folder with spaces/notes.md"`.

When you send the request:

- text files up to 100 KB are sent in full (up to 300 KB per request);
- larger files, images and PDFs are sent as paths for the agent to read;
- folders are sent as a list of their files (up to 300).

On Windows, network shares and device paths are never read unless your repository is on that share.

## How a run works

1. PIRL starts the coordinator in your agent CLI, in non-interactive mode. Each role runs as its own subagent,
   with only the tools its job needs, and the chat shows what each one is doing.
2. When the work needs your decision, the run asks. Pick an answer with ↑ / ↓ and Enter, or type your own.
3. When the coordinator finishes, PIRL runs the framework's validator and checks the self-evaluation record.
   After Implement, it also checks that only the Plan's allowed paths changed. A failed check sends the
   coordinator back to fix it, at most twice.
4. If the run improved the framework, PIRL runs the framework's tests on the change, then asks whether to commit
   it to the Hub, keep it uncommitted, or discard it.
5. PIRL suggests the next layer as a command. It never opens a layer on its own.

A run never commits, pushes or switches branches in your repository. Commands outside a run's permissions are
refused and listed in the run's summary; the run carries on. Esc or Ctrl+C stops a run, and `/resume` continues
it later in the same agent session, even after PIRL was closed.

## Usage and limits

Every run calls the agent several times, for the coordinator and each role, and each call counts toward your
subscription limits. The side panel shows the share of your 5-hour and weekly limits already used, with their
reset times. When a run finishes, it reports:

- tokens by kind: cache reads, cache writes, output and new input, including the roles';
- their equivalent at API list prices;
- your limits before and after the run, when the agent reports them.

Most tokens are cache reads, which cost a fraction of new input. To spend less, choose a lighter model or a lower
reasoning effort in `/settings`. PIRL also gives each run only the tools it needs and does not load your MCP
servers, so each request carries less context.

## Settings

| Setting | Options |
| --- | --- |
| Language | Tiếng Việt (default) or English: the language of PIRL's own text, including `pirl --help` and `pirl update` |
| Coordinator model | Sonnet (default), Opus, Fable, Haiku, or the agent's default |
| Role model | Same as the coordinator (default), or a specific model |
| Reasoning effort | Agent default, low, medium, high, xhigh, max; applies to the coordinator and every role |
| Mouse | PIRL selects text and scrolls with the wheel (default), the terminal handles the mouse, or off |
| Parallel roles | 1 to 4 roles of a run working at the same time (default 2) |
| Appearance | Color scheme, light or dark background, Unicode or ASCII glyphs, motion |

## Framework updates

On first start, PIRL creates the Hub in `~/.pirl/hub`: a local Git repository holding the framework that ships
with the CLI. Its `upstream` branch keeps the original framework versions; `main` keeps them plus your
improvements, and runs use `main`.

When a newer CLI brings a newer framework, the header says so. Open `/framework` to update when you choose:

1. PIRL merges the new version into a draft; `main` is untouched.
2. Where your improvements and the new version change the same lines, you see both sides and choose: keep yours,
   take the new version, let the agent merge them, or edit by hand.
3. PIRL runs the framework's tests on the draft. If they pass, `main` moves to the draft; if not, nothing changes.

`/framework` can also undo the last update, list your local improvements with their diffs, restore a file to the
original, and show the history of improvements.

## Where your data lives

| Data | Location |
| --- | --- |
| Hub (framework, Plans, review reports) | `~/.pirl/hub` |
| Self-evaluation records | `~/.pirl/hub/.agents/evals/records/` |
| Settings | `~/.pirl/config.json` |
| Runs for `/resume` | `~/.pirl/sessions/` |
| Full log of each run | `~/.pirl/logs/` |

Plans, reports and records stay in the Hub, never in your project repository. Set `PIRL_HOME` to use another
directory than `~/.pirl`.

## Updating PIRL

Run `pirl update` outside the TUI. It asks npm for the newest version and installs it with
`npm install -g pirl-framework-cli@<version>`. If npm needs administrator rights to write the global folder,
`pirl update` prints the command to run with them.

Each time PIRL starts, it asks npm in the background, so the TUI never waits for it. When a newer version is out,
the header shows "Có PIRL x.y.z" and a note in the chat says how to update. Without a network connection, PIRL
uses npm's last answer. Set `PIRL_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`)
to turn the check off; it is also off in CI.

A new version of PIRL may bring a new version of the framework. Your Hub is not changed by the update: open
`/framework` to apply the new framework when you choose.
