<div align="center">

# git-blame-stats

**See exactly who owns what in your codebase — by author, file, directory, and language**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/git-blame-stats
```

Short alias: `gbs`

## Usage

```bash
# Full ownership report for the current repo
npx github:NickCirv/git-blame-stats

# Leaderboard with first/last commit dates
npx github:NickCirv/git-blame-stats leaderboard
```

| Flag | Description |
|------|-------------|
| `<file>` | Blame breakdown for a single file |
| `--dir <path>` | Scope analysis to a directory |
| `--lang <ext>` | Filter by extension (e.g. `ts`, `py`, `go`) |
| `--author <name>` | Per-file breakdown for one author |
| `--top <N>` | Top N files by author count (churn indicator) |
| `--since <date>` | Limit to recent blame (e.g. `"3 months ago"`) |
| `--format json` | Machine-readable JSON output |

## What it does

Runs `git blame --line-porcelain` across every tracked file in your repo and tallies line ownership per author. Results render as a colored ownership table, a ranked leaderboard with commit-date ranges, or JSON for CI pipelines. Binary files and files over 10 MB are skipped automatically; 10 files are processed in parallel with a live progress indicator.

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
