# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-27

### Changed

- `/resume` no longer continues a run as soon as you choose it.
  PIRL waits for your message, "continue" or a related problem for the run to solve, and sends it to the run's agent session; Esc cancels.
  A run that was waiting for your answers shows its questions again.
- A layer run that ends without its result (a Plan package, the Plan file or a Review report) and without asking you anything is no longer reported as "Done".
  PIRL sends it back to finish or to ask what is missing, as it does for a failed validator; if there is still no result, the run ends as "No result" with the reason, and `/resume` can continue it.
- A question that needs content only you have (text, data, values) is asked as a free answer you type, not as an option such as "I will write it", which sent no content.

### Fixed

- Esc stops a run on Windows.
  Claude Code installed by npm runs under a `claude.cmd` shim, and only the shim was stopped: the agent kept working and the run stayed "running".
  PIRL now ends the whole process tree, also when PIRL closes.
- On every system, a provider that ignores the stop request is ended after a few seconds, and the run ends once it is gone, even if a process it started keeps the output open.
- Esc tells you the run is stopping, and a second Esc forces it at once.
- Esc also stops a run that waits for your answers, as the hint said; it can be resumed later.
- A run stopped while PIRL checked its results no longer comes back to ask about framework improvements.
- With English chosen, a file the agent writes shows as "Write <path>", not "Ghi <path>".
- The run log records a refused improvements decision (a commit while the framework tests fail, or a commit or discard that Git refused); before, only the run block showed it.

### Framework fw-1.3.0

- A run that stops to ask you something is paused, not finished: `process-auditor` evaluates it once, when its output is settled, instead of at every pause, which cost a large part of runs that asked questions.
- Plan asks first, before assigning any role, when the request does not say what to change or what the new content is.
- Roles that run in parallel get parts that do not overlap.
  The coordinator no longer reads the sources it hands to roles, and each role reads only what its part needs.
- A question about content only you have asks for that content itself.
- The framework's Markdown files are no longer hard-wrapped at a fixed width.
  A line ends only where a sentence ends with `.`, `?` or `!`, never at `;`, and at `:` only before a list, a table or a code block, so a phrase is never split across lines and can be found with a plain search.
  Headings, tables, code blocks and the output templates keep their form; every file renders as before.
- Framework maintenance keeps this convention for every Markdown file it edits.

## [1.1.2] - 2026-10-26

### Added

- Choose the interface language in `/settings`: Tiếng Việt (the default) or English.
  The change applies at once, to the TUI and to `pirl --help` and `pirl update`.
  Agents still reply in the language of your request.
  PIRL's own messages to the agent (validator fixes, your answers, /resume) follow the chosen language too.

### Framework fw-1.2.0

- Implement roles finish a clean-code check before handing over to the verification roles: they write only the code the required logic needs, reuse existing logic, and check that the new code is clean, free of potential bugs and maintainable, and that every line has a purpose.

## [1.1.1] - 2026-10-25

### Fixed

- Changing the mouse setting in `/settings` no longer closes PIRL with "destroy_ is not a function".
  The bug was present since 1.0.0.

## [1.1.0] - 2026-10-25

### Added

- `pirl update` installs the newest version of PIRL from npm.
  A copy run from its source is left alone, with the way to update it.
- PIRL tells you when a new version is out: the header shows it and a note in the chat says how to update.
  npm is asked in the background each time PIRL starts; `PIRL_NO_UPDATE_CHECK=1` turns the check off.
- Select text with the mouse across more than one screen: drag in the chat or an open panel, without Shift; while the button is held, the wheel or the pointer past an edge scrolls on and extends the selection.
  Releasing copies it to the clipboard.
  The right button pastes.

### Changed

- The mouse settings are now "Bôi đen tự do" (PIRL selects text; the default), "Để terminal xử lý" (the terminal selects text on screen and the wheel scrolls through the arrow keys) and off.
  1.0's "Con lăn của PIRL" becomes the default, which also scrolls with the wheel.
  ↑ / ↓ recall sent messages again, except when the terminal handles the mouse.

### Fixed

- Code blocks in replies keep their indentation; it was stripped, so code was shown, and would have been copied, flush left.
  Tabs are drawn as spaces to the next multiple of four instead of pushing the rest of the line out of place.

## [1.0.1] - 2026-10-25

Documentation and tests only: the CLI and the bundled framework (fw-1.1.0) are the same as in 1.0.0.

### Added

- A [user guide](docs/user-guide.md) with the details of using PIRL: commands, keyboard shortcuts, `@` attachments, how a run works, usage limits, settings, framework updates and where data is stored.
- Uninstallation steps in the README.

### Changed

- The README is now in English and introduces the product: highlights, requirements, installation, quick start, documentation links, uninstallation and development.
- The changelog is now in English.

### Fixed

- The test suite no longer times out on slower Windows computers, where it stopped `npm test` and so `npm publish`.

## [1.0.0] - 2026-10-25

First release, published on npm as `pirl-framework-cli`.
Provider: Claude Code 2.1.281 or later.
Bundled framework: fw-1.1.0.

### Added

- A terminal UI started with `pirl` in a Git repository, which becomes the target repository.
- `/pirl-plan`, `/pirl-implement` and `/pirl-review` run a PIRL layer through your Claude Code.
  Each role runs as its own subagent, with permissions set per layer.
- Text typed without a `/` is a question, a standalone task or framework maintenance.
  When it asks for a layer, the run suggests the matching command instead of running it.
- Questions during a run: pick an answer with the arrow keys, type its number, or write your own.
- `/resume` lists the runs of the repository that can continue and resumes the one you choose, even after the TUI was closed.
- After each run, PIRL runs the framework's validator and checks the self-evaluation record.
  After Implement, it checks that the changed files are within the Plan's allowed paths.
- Framework improvements made by a run are tested with the framework's own tests before PIRL offers to commit them to the Hub; an improvement that fails the tests cannot be committed.
- `/framework`:
  - update to the framework bundled with the CLI through a draft, with a three-way merge;
  - resolve conflicts by keeping your version, taking the new one, letting the agent merge them, or editing by hand;
  - run the framework's tests before applying an update;
  - undo the last update;
  - view differences from the original, restore single files, and browse the history of improvements.
- `/plans` and `/records`: open a Plan, a review report or a record to see its details.
- Attach files and folders with `@`: paths of the repository are suggested as you type.
  Small text files are sent with their content; large files and folders are sent as paths or file lists.
  On Windows, network (UNC) and device paths are never read, except on the share that holds the repository or the home directory.
- Run progress: a spinner, a clock and what each role is doing; the full log of each run in `~/.pirl/logs/`.
- Token usage by kind (cache reads, cache writes, output, new input), including the roles', with its equivalent at API list prices.
- 5-hour and weekly usage limits in the side panel, with percentage bars and reset times.
- Mouse wheel scrolling of the chat and panels, while dragging still selects text as usual.
- `/settings`: coordinator model (Sonnet by default), role model, reasoning effort for every role, parallel roles, color scheme, light or dark background, glyphs, motion and mouse mode.
- `/doctor`, `/copy`, `/clear`, `/help` and `/exit`; paste with Ctrl+V; new lines with Shift+Enter, Ctrl+J or `\` then Enter.
- A responsive layout from 40 columns, and support for Vietnamese input methods.

### Framework fw-1.1.0

- The details of self-evaluation moved to `self-evaluation.instructions.md`, with a JSON template for records.
  No rule changed.
- Plans, reports and records use the computer's time zone instead of a fixed UTC+7.
- The validator reads quoted frontmatter strings literally.
  Before, a Windows path in `target_repo` (`"C:\Users\..."`) was rejected, and the `\n` in `"D:\new-app"` became a line break.

[1.2.0]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.2.0
[1.1.2]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.1.2
[1.1.1]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.1.1
[1.1.0]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.1.0
[1.0.1]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.0.1
[1.0.0]: https://github.com/tdmadc107/PIRL-CLI/releases/tag/v1.0.0
