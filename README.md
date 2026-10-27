# PIRL CLI

[![npm](https://img.shields.io/npm/v/pirl-framework-cli)](https://www.npmjs.com/package/pirl-framework-cli) [![CI](https://github.com/tdmadc107/PIRL-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/tdmadc107/PIRL-CLI/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Plan, implement and review code changes with a team of AI agents, from your terminal.**

PIRL CLI runs the [PIRL framework](pirl-framework/README.md) through the AI agent CLI you already use.
Describe the work, and PIRL turns it into a Plan, implements it and reviews the result, with specialist agent roles at each step and the framework's own checks after each run.

PIRL CLI has no login of its own:
it uses your agent CLI under your subscription and never reads, stores or forwards its credentials.

## Highlights

- **Plan → Implement → Review** as three commands, each handled by specialist agent roles.
- **Checked results**:
  every run is validated by the framework's tools before you see it as done.
- **Your repository stays yours**:
  runs never commit, push or switch branches.
- **A framework that improves itself**, with every change tested and left to your approval.

## Requirements

- Node.js 22 or later
- Git
- Python 3.9 or later
- [Claude Code](https://code.claude.com/docs) 2.1.281 or later, installed and signed in

Support for Codex CLI, Gemini CLI and Copilot CLI is planned.

## Installation

```bash
npm install -g pirl-framework-cli
```

Verify the installation:

```bash
pirl --version
```

## Updating

```bash
pirl update
```

PIRL also tells you when a new version is out, in the header and in the chat.

## Quick start

Start PIRL in the Git repository you want to work on:

```bash
cd path/to/your-project
pirl
```

Then describe the work as a Plan:

```text
/pirl-plan Send customers an email when their order is cancelled
```

PIRL suggests the next step when the Plan is ready.
Type `/help` in PIRL for all commands and shortcuts.

## Documentation

- [User guide](docs/user-guide.md):
  commands, shortcuts, attaching files, settings, usage limits and framework updates
- [PIRL framework](pirl-framework/README.md):
  the layers, roles and self-improvement behind PIRL
- [Changelog](CHANGELOG.md)

## Uninstallation

```bash
npm uninstall -g pirl-framework-cli
```

Your Hub, settings and run history stay in `~/.pirl` (`%USERPROFILE%\.pirl` on Windows).
Delete that folder to remove them as well.

## Development

```bash
git clone https://github.com/tdmadc107/PIRL-CLI.git
cd PIRL-CLI
npm ci
npm run dev    # run from source
npm test       # run the tests
```

## License

[MIT](LICENSE)
