#!/usr/bin/env node
// git-blame-stats — zero-dependency git blame statistics analyzer
// Usage: git-blame-stats [file|--dir path|--lang ext|--author name|--top N|--since date|--format json|leaderboard]

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, extname, relative, dirname } from 'path';
import { createInterface } from 'readline';

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};
const AUTHOR_COLOURS = [C.cyan, C.green, C.yellow, C.magenta, C.red];
const noColour = process.env.NO_COLOR || process.env.TERM === 'dumb';
const c = (code, str) => noColour ? str : `${code}${str}${C.reset}`;

// ── CLI argument parsing ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    subcommand: null,
    file: null,
    dir: null,
    lang: null,
    author: null,
    top: null,
    since: null,
    format: 'text',
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case '--help': case '-h':
        opts.help = true; break;
      case '--dir':
        opts.dir = args[++i]; break;
      case '--lang':
        opts.lang = args[++i]?.replace(/^\./, ''); break;
      case '--author':
        opts.author = args[++i]; break;
      case '--top':
        opts.top = parseInt(args[++i], 10); break;
      case '--since':
        opts.since = args[++i]; break;
      case '--format':
        opts.format = args[++i]; break;
      case 'leaderboard':
        opts.subcommand = 'leaderboard'; break;
      default:
        if (!a.startsWith('-') && !opts.subcommand) {
          if (existsSync(a)) {
            const st = statSync(a);
            if (st.isFile()) opts.file = a;
            else if (st.isDirectory()) opts.dir = a;
          } else {
            opts.subcommand = a;
          }
        }
    }
    i++;
  }
  return opts;
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function gitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function gitTrackedFiles(dir, since) {
  const extraArgs = since ? ['--diff-filter=A', `--since=${since}`] : [];
  // Use ls-files for full list, git log --name-only for since filter
  if (since) {
    const result = spawnSync('git', [
      'log', '--name-only', '--pretty=format:', `--since=${since}`, '--diff-filter=AM'
    ], { encoding: 'utf8', cwd: dir });
    if (result.error || result.status !== 0) return [];
    const files = [...new Set(
      result.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    )];
    return files.map(f => resolve(dir, f)).filter(f => existsSync(f));
  }
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    cwd: dir,
  });
  if (result.error || result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(f => resolve(dir, f))
    .filter(f => existsSync(f));
}

function isBinarySync(filePath) {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return false;
    if (st.size > 10 * 1024 * 1024) return true;
    const buf = readFileSync(filePath, { flag: 'r' });
    const check = buf.slice(0, 8192);
    for (let i = 0; i < check.length; i++) {
      if (check[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ── Blame parser ──────────────────────────────────────────────────────────────
function blameFile(filePath, since) {
  // returns Map<authorName, lineCount>
  try {
    const args = ['blame', '--line-porcelain'];
    if (since) args.push(`--since=${since}`);
    args.push('--', filePath);

    const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (result.error || result.status !== 0) return null;

    const lines = result.stdout.split('\n');
    const authorMap = new Map();
    for (const line of lines) {
      if (line.startsWith('author ')) {
        const name = line.slice(7).trim();
        if (name && name !== 'Not Committed Yet') {
          authorMap.set(name, (authorMap.get(name) || 0) + 1);
        }
      }
    }
    return authorMap;
  } catch {
    return null;
  }
}

// ── Progress bar helper ───────────────────────────────────────────────────────
function progress(current, total, label = '') {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${c(C.dim, `Analyzing ${current}/${total} files... ${label}`)}`);
  }
}
function clearProgress() {
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }
}

// ── Batch parallel processing ─────────────────────────────────────────────────
async function analyzeFiles(files, opts = {}) {
  const BATCH = 10;
  const results = [];
  let done = 0;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (f) => {
        done++;
        progress(done, files.length, relative(process.cwd(), f).slice(0, 30));
        if (isBinarySync(f)) return { file: f, blame: null, skipped: true };
        const blame = blameFile(f, opts.since);
        return { file: f, blame, skipped: false };
      })
    );
    results.push(...batchResults);
  }
  clearProgress();
  return results;
}

// ── Aggregate stats ───────────────────────────────────────────────────────────
function aggregate(fileResults) {
  // authorTotals: Map<author, { lines, files: Set }>
  const authorTotals = new Map();
  let totalLines = 0;

  for (const { file, blame, skipped } of fileResults) {
    if (!blame || skipped) continue;
    for (const [author, count] of blame) {
      if (!authorTotals.has(author)) authorTotals.set(author, { lines: 0, files: new Set() });
      const entry = authorTotals.get(author);
      entry.lines += count;
      entry.files.add(file);
      totalLines += count;
    }
  }

  const sorted = [...authorTotals.entries()]
    .map(([author, data]) => ({
      author,
      lines: data.lines,
      files: data.files.size,
      pct: totalLines > 0 ? (data.lines / totalLines) * 100 : 0,
    }))
    .sort((a, b) => b.lines - a.lines);

  return { authors: sorted, totalLines };
}

// ── ASCII bar chart ───────────────────────────────────────────────────────────
function bar(pct, width = 40) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Number formatters ─────────────────────────────────────────────────────────
function fmt(n) { return n.toLocaleString(); }
function pctFmt(p) { return p.toFixed(1).padStart(5) + '%'; }

// ── Leaderboard: per-author first/last commit dates ───────────────────────────
function authorCommitDates(author) {
  try {
    const args = ['log', '--author', author, '--format=%aI', '--'];
    const result = spawnSync('git', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) return { first: null, last: null };
    const dates = result.stdout.split('\n').map(d => d.trim()).filter(Boolean);
    if (!dates.length) return { first: null, last: null };
    return { first: dates[dates.length - 1]?.slice(0, 10), last: dates[0]?.slice(0, 10) };
  } catch {
    return { first: null, last: null };
  }
}

// ── Views ─────────────────────────────────────────────────────────────────────
function printOwnershipReport(authors, totalLines, title = 'Code Ownership Report') {
  console.log();
  console.log(c(C.bold, `  ${title}`));
  console.log(c(C.dim, `  ${'─'.repeat(70)}`));
  console.log(c(C.dim, `  ${'Author'.padEnd(25)} ${'Lines'.padStart(8)} ${'Files'.padStart(6)}  ${'Share'.padStart(6)}  Bar`));
  console.log(c(C.dim, `  ${'─'.repeat(70)}`));

  const top = authors.slice(0, 5);
  const rest = authors.slice(5);

  top.forEach(({ author, lines, files, pct }, idx) => {
    const colour = AUTHOR_COLOURS[idx % AUTHOR_COLOURS.length];
    const barStr = bar(pct, 30);
    console.log(
      `  ${c(colour, author.padEnd(25))} ${fmt(lines).padStart(8)} ${String(files).padStart(6)}  ${pctFmt(pct)}  ${c(colour, barStr)}`
    );
  });

  if (rest.length) {
    const otherLines = rest.reduce((s, a) => s + a.lines, 0);
    const otherFiles = new Set(rest.flatMap(a => [])).size; // approximate
    const otherPct = totalLines > 0 ? (otherLines / totalLines) * 100 : 0;
    console.log(
      `  ${c(C.dim, `(${rest.length} others)`.padEnd(25))} ${fmt(otherLines).padStart(8)} ${''.padStart(6)}  ${pctFmt(otherPct)}  ${c(C.dim, bar(otherPct, 30))}`
    );
  }

  console.log(c(C.dim, `  ${'─'.repeat(70)}`));
  console.log(`  ${c(C.bold, 'Total')}${''.padEnd(20)} ${fmt(totalLines).padStart(8)}`);
  console.log();
}

function printFileReport(file, blame) {
  const entries = [...blame.entries()].map(([author, lines]) => ({ author, lines }));
  const total = entries.reduce((s, e) => s + e.lines, 0);
  const sorted = entries.sort((a, b) => b.lines - a.lines).map(e => ({
    ...e,
    pct: total > 0 ? (e.lines / total) * 100 : 0,
  }));

  console.log();
  console.log(c(C.bold, `  File: ${relative(process.cwd(), file)}`));
  console.log(c(C.dim, `  Total lines: ${fmt(total)}`));
  console.log(c(C.dim, `  ${'─'.repeat(60)}`));

  sorted.forEach(({ author, lines, pct }, idx) => {
    const colour = AUTHOR_COLOURS[idx % AUTHOR_COLOURS.length];
    console.log(`  ${c(colour, author.padEnd(25))} ${fmt(lines).padStart(8)}  ${pctFmt(pct)}  ${c(colour, bar(pct, 20))}`);
  });
  console.log();
}

function printTopChurn(fileResults, topN = 10) {
  // top files by number of distinct authors
  const ranked = fileResults
    .filter(r => r.blame && !r.skipped)
    .map(r => {
      const authors = r.blame.size;
      const lines = [...r.blame.values()].reduce((s, v) => s + v, 0);
      return { file: r.file, authors, lines };
    })
    .sort((a, b) => b.authors - a.authors)
    .slice(0, topN);

  console.log();
  console.log(c(C.bold, `  Top ${topN} Files by Author Count (churn indicators)`));
  console.log(c(C.dim, `  ${'─'.repeat(70)}`));
  console.log(c(C.dim, `  ${'File'.padEnd(50)} ${'Authors'.padStart(7)} ${'Lines'.padStart(8)}`));
  console.log(c(C.dim, `  ${'─'.repeat(70)}`));

  ranked.forEach(({ file, authors, lines }, i) => {
    const shortFile = relative(process.cwd(), file).slice(0, 50);
    const colour = authors > 5 ? C.red : authors > 3 ? C.yellow : C.green;
    console.log(`  ${c(colour, shortFile.padEnd(50))} ${String(authors).padStart(7)} ${fmt(lines).padStart(8)}`);
  });
  console.log();
}

async function printLeaderboard(authors, since) {
  console.log();
  console.log(c(C.bold, '  Leaderboard'));
  console.log(c(C.dim, `  ${'─'.repeat(80)}`));
  console.log(c(C.dim, `  ${'#'.padEnd(4)} ${'Author'.padEnd(25)} ${'Lines'.padStart(8)} ${'Files'.padStart(6)}  ${'Share'.padStart(6)}  ${'First'.padStart(10)}  ${'Last'.padStart(10)}`));
  console.log(c(C.dim, `  ${'─'.repeat(80)}`));

  for (let i = 0; i < Math.min(authors.length, 20); i++) {
    const { author, lines, files, pct } = authors[i];
    const { first, last } = authorCommitDates(author);
    const colour = AUTHOR_COLOURS[i % AUTHOR_COLOURS.length];
    const rank = String(i + 1).padEnd(4);
    console.log(
      `  ${rank} ${c(colour, author.padEnd(25))} ${fmt(lines).padStart(8)} ${String(files).padStart(6)}  ${pctFmt(pct)}  ${(first || 'n/a').padStart(10)}  ${(last || 'n/a').padStart(10)}`
    );
  }
  console.log();
}

function printAuthorBreakdown(fileResults, authorFilter) {
  console.log();
  console.log(c(C.bold, `  Contributions by: ${authorFilter}`));
  console.log(c(C.dim, `  ${'─'.repeat(70)}`));

  const matched = fileResults
    .filter(r => r.blame && !r.skipped)
    .flatMap(r => {
      const match = [...r.blame.entries()].find(([a]) =>
        a.toLowerCase().includes(authorFilter.toLowerCase())
      );
      if (!match) return [];
      return [{ file: r.file, lines: match[1], total: [...r.blame.values()].reduce((s, v) => s + v, 0) }];
    })
    .sort((a, b) => b.lines - a.lines);

  if (!matched.length) {
    console.log(c(C.dim, `  No contributions found for "${authorFilter}"`));
    console.log();
    return;
  }

  let totalLines = 0;
  for (const { file, lines, total } of matched) {
    const pct = total > 0 ? (lines / total) * 100 : 0;
    const shortFile = relative(process.cwd(), file).slice(0, 45);
    console.log(`  ${shortFile.padEnd(45)} ${fmt(lines).padStart(8)} lines  ${pctFmt(pct)} of file`);
    totalLines += lines;
  }

  console.log(c(C.dim, `  ${'─'.repeat(70)}`));
  console.log(`  ${c(C.bold, 'Total owned lines:')} ${fmt(totalLines)}`);
  console.log();
}

// ── Help ──────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${c(C.bold, 'git-blame-stats')} — analyze code ownership via git blame

${c(C.bold, 'USAGE')}
  git-blame-stats                      Full ownership report for current repo
  git-blame-stats <file>               Blame stats for a specific file
  git-blame-stats leaderboard          Ranked author table with commit dates
  git-blame-stats --dir <path>         Stats for a directory
  git-blame-stats --lang <ext>         Filter by file extension (e.g. js, ts, py)
  git-blame-stats --author <name>      Per-file breakdown for one author
  git-blame-stats --top <N>            Top N files by most authors (churn indicator)
  git-blame-stats --since <date>       Limit to recent blame (e.g. "6 months ago")
  git-blame-stats --format json        Machine-readable JSON output

${c(C.bold, 'OPTIONS')}
  --dir <path>      Target directory (default: current directory)
  --lang <ext>      Filter files by extension
  --author <name>   Show only this author's contributions
  --top <N>         Show top N files by author count (default: 10)
  --since <date>    Limit analysis to files modified since date
  --format json     Output JSON instead of text
  --help, -h        Show this help

${c(C.bold, 'ALIASES')}
  gbs               Short alias for git-blame-stats

${c(C.bold, 'EXAMPLES')}
  git-blame-stats
  git-blame-stats src/index.js
  git-blame-stats --lang ts --since "3 months ago"
  git-blame-stats --author "Alice"
  git-blame-stats --top 5
  git-blame-stats leaderboard
  git-blame-stats --format json > stats.json
`);
}

// ── JSON output ───────────────────────────────────────────────────────────────
function toJson(authors, totalLines, fileResults) {
  return JSON.stringify({
    totalLines,
    analyzedFiles: fileResults.filter(r => !r.skipped).length,
    skippedFiles: fileResults.filter(r => r.skipped).length,
    authors: authors.map(a => ({
      author: a.author,
      lines: a.lines,
      files: a.files,
      percentage: parseFloat(a.pct.toFixed(2)),
    })),
  }, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Verify we're in a git repo
  const root = gitRoot();
  if (!root) {
    console.error(c(C.red, 'Error: not inside a git repository.'));
    process.exit(1);
  }

  // ── Single file mode ────────────────────────────────────────────────────────
  if (opts.file) {
    const absFile = resolve(opts.file);
    if (isBinarySync(absFile)) {
      console.error(c(C.red, 'File appears to be binary — skipping.'));
      process.exit(1);
    }
    const blame = blameFile(absFile, opts.since);
    if (!blame || blame.size === 0) {
      console.error(c(C.red, 'No blame data found. Is this file tracked by git?'));
      process.exit(1);
    }
    if (opts.format === 'json') {
      const total = [...blame.values()].reduce((s, v) => s + v, 0);
      const authors = [...blame.entries()]
        .map(([author, lines]) => ({ author, lines, files: 1, pct: total > 0 ? (lines / total) * 100 : 0 }))
        .sort((a, b) => b.lines - a.lines);
      console.log(toJson(authors, total, [{ file: absFile, blame, skipped: false }]));
    } else {
      printFileReport(absFile, blame);
    }
    return;
  }

  // ── Directory / repo mode ───────────────────────────────────────────────────
  const targetDir = opts.dir ? resolve(opts.dir) : process.cwd();

  let files = gitTrackedFiles(targetDir, opts.since);

  // Filter by language
  if (opts.lang) {
    const ext = `.${opts.lang}`;
    files = files.filter(f => extname(f) === ext);
  }

  // Limit to target directory
  files = files.filter(f => f.startsWith(targetDir));

  if (!files.length) {
    console.error(c(C.yellow, 'No files matched the given filters.'));
    process.exit(1);
  }

  console.log(c(C.dim, `  Found ${files.length} files to analyze...`));

  const fileResults = await analyzeFiles(files, { since: opts.since });
  const { authors, totalLines } = aggregate(fileResults);

  if (!authors.length) {
    console.error(c(C.yellow, 'No blame data found (all files may be untracked or binary).'));
    process.exit(1);
  }

  // ── --top mode ──────────────────────────────────────────────────────────────
  if (opts.top !== null && opts.top !== undefined) {
    if (opts.format === 'json') {
      const ranked = fileResults
        .filter(r => r.blame && !r.skipped)
        .map(r => ({ file: relative(process.cwd(), r.file), authors: r.blame.size }))
        .sort((a, b) => b.authors - a.authors)
        .slice(0, opts.top);
      console.log(JSON.stringify(ranked, null, 2));
    } else {
      printTopChurn(fileResults, opts.top);
    }
    return;
  }

  // ── --author mode ───────────────────────────────────────────────────────────
  if (opts.author) {
    if (opts.format === 'json') {
      const matched = fileResults
        .filter(r => r.blame && !r.skipped)
        .flatMap(r => {
          const match = [...r.blame.entries()].find(([a]) =>
            a.toLowerCase().includes(opts.author.toLowerCase())
          );
          if (!match) return [];
          return [{ file: relative(process.cwd(), r.file), lines: match[1] }];
        });
      console.log(JSON.stringify(matched, null, 2));
    } else {
      printAuthorBreakdown(fileResults, opts.author);
    }
    return;
  }

  // ── leaderboard ─────────────────────────────────────────────────────────────
  if (opts.subcommand === 'leaderboard') {
    if (opts.format === 'json') {
      const enhanced = authors.slice(0, 20).map(a => ({
        ...a,
        ...authorCommitDates(a.author),
      }));
      console.log(JSON.stringify(enhanced, null, 2));
    } else {
      await printLeaderboard(authors, opts.since);
    }
    return;
  }

  // ── Default: full ownership report ─────────────────────────────────────────
  if (opts.format === 'json') {
    console.log(toJson(authors, totalLines, fileResults));
  } else {
    const lang = opts.lang ? ` [.${opts.lang} files]` : '';
    const dirLabel = opts.dir ? ` — ${relative(process.cwd(), targetDir) || targetDir}` : '';
    printOwnershipReport(authors, totalLines, `Code Ownership Report${dirLabel}${lang}`);
  }
}

main().catch(err => {
  console.error(c(C.red, `Fatal: ${err.message}`));
  process.exit(1);
});
