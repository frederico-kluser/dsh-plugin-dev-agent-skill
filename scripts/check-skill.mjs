#!/usr/bin/env node
/**
 * check-skill.mjs — zero-dependency self-check validator for the dsh-plugin-dev skill.
 * Validates the skill repo (parent of scripts/):
 *   1 frontmatter   2 mandatory sections   3 internal links
 *   4 forbidden claims (hard FAIL in prose, WARN in Anti-patterns)   5 placeholders
 * Exit: 0 ok | 1 failures | 2 usage. Flags: --list, --strict, -h/--help.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // skill root = parent of scripts/

/* ---- static data (embedded constants) ---------------------------------- */

// Mandatory top-level section headings expected in SKILL.md (Stage 2).
const REQUIRED_SECTIONS = [
  '## What you will learn',
  '## How to install',
  '## Creating a plugin',
  '## Interface (frontend)',
  '## Functionality (backend)',
  '## Security',
  '## Testing',
  '## Packaging & publishing',
  '## Anti-patterns to avoid',
];

// Forbidden claims, copied literally from docs/PROIBIDO.md. These are REFUTED or
// UNCONFIRMED claims that must never be taught as truth. Normalized at load time.
const FORBIDDEN_SOURCE = [
  'O limite do plano Zero Trust free é 50 usuários',
  'O limite do plano Zero Trust free é de 50 usuários',
  'Benchmarks do jcode',
  'o pacote pi2dsh',
  'pi2dsh',
  'Quick tunnel não suporta SSE',
  'quick tunnel não suporta SSE',
  'Quem tem o token do bot contorna a allowlist',
  'o token do bot contorna a allowlist',
  'drop_pending_updates é parâmetro de getUpdates',
  'O ASVS 5.0 §6.5.2 autoriza SHA-256 em vez de Argon2 para tokens de 128 bits',
  'URLs de quick tunnel são indexadas por motores de busca',
  'child.kill() nunca basta quando há shell intermediário',
  'O cookie Secure não funciona em http://127.0.0.1',
  'Existe campo de compatibilidade no package.json',
  'uma dependência de runtime a mais para o host',
  'dsh-guarded-bot-orchestrator tem N dependências de runtime',
];

const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const FORBIDDEN = [...new Set(FORBIDDEN_SOURCE.map(normalize))];
const PROTECTED_HEADING = /(anti-pattern|avoid|proibido)/i;
// TODO/FIXME/TBD are case-SENSITIVE (uppercase or US-style prefix) so PT words like
// 'Método' (whose trailing é breaks \b mid-word) and 'Todo' (= 'all') never
// false-positive. A following char that is [:(\s] or end-of-line guards against a
// letter continuation. 'lorem ipsum' and '<INSIRA' stay case-insensitive.
const TODO_RE = /(?:^|[\sA-Z])(?:TODO|FIXME|TBD)(?:[:(\s]|$)/;
const PLACEHOLDER_RE = (line) =>
  TODO_RE.test(line) || /lorem(?:\s+ipsum)?|<INSIRA/i.test(line);
const HAS_OPEN_BRACE = /\{\{/;
const ESC = String.fromCharCode(27); // ANSI escape, avoids backslash-escape pitfalls

/* ---- helpers ------------------------------------------------------------- */

/** Collect every .md file under dir, skipping vcs/node_modules. */
function walkMds(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    // Internal orchestration state (run-*/TASK_PLAN.md notebooks) is never published
    // to the skill and contains refuted claims re-discussed in prose, so exclude it.
    if (e.name === '.deep-orchestrator') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMds(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Parse `key: value` frontmatter lines; merges wrapped indented values. */
function parseFrontmatter(raw) {
  const fm = {};
  let key = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) { key = m[1]; fm[key] = m[2].trim(); }
    else if (key && /^\s+/.test(line) && fm[key] !== undefined) fm[key] += ' ' + line.trim();
  }
  return fm;
}

const readLines = (abs) => fs.readFileSync(abs, 'utf8').split(/\r?\n/);
const findings = [];
const addFinding = (f) => findings.push(f);

/* ---- Stage 1: frontmatter ------------------------------------------------ */
function stageFrontmatter(skillPath) {
  const text = fs.readFileSync(skillPath, 'utf8');
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!m) {
    addFinding({ stage: '1-frontmatter', severity: 'fail', file: skillPath,
      message: 'SKILL.md has no YAML frontmatter block (leading --- ... ---).' });
    return null;
  }
  const fm = parseFrontmatter(m[1]);
  if (!fm.name) addFinding({ stage: '1-frontmatter', severity: 'fail', file: skillPath,
    message: 'frontmatter key "name" is missing or empty.' });
  if (!fm.description) addFinding({ stage: '1-frontmatter', severity: 'fail', file: skillPath,
    message: 'frontmatter key "description" is missing or empty.' });
  else {
    const d = fm.description.toLowerCase();
    if (!d.includes('dsh')) addFinding({ stage: '1-frontmatter', severity: 'fail',
      file: skillPath, message: 'frontmatter "description" must contain "dsh".' });
    if (!d.includes('deepseek')) addFinding({ stage: '1-frontmatter', severity: 'fail',
      file: skillPath, message: 'frontmatter "description" must contain "deepseek".' });
  }
  return fm;
}

/* ---- Stage 2: mandatory sections (compared by heading text) -------------- */
function stageSections(skillPath, body) {
  const text = (s) => s.replace(/^#+\s*/, '').trim();
  const seen = new Set();
  for (const line of body) {
    const hm = line.match(/^#{1,6}\s+(.+)$/);
    if (hm) seen.add(text(hm[1]));
  }
  for (const req of REQUIRED_SECTIONS) {
    if (!seen.has(text(req))) addFinding({ stage: '2-sections', severity: 'fail',
      file: skillPath, message: 'missing mandatory section: ' + req });
  }
}

/* ---- Stage 3: internal links (relative targets must resolve) ------------- */
function stageLinks(mdList) {
  const inlineRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const refDefRe = /^\s*\[([^\]]+)\]\s*:\s*(\S+)/;
  for (const file of mdList) {
    const lines = readLines(file);
    const dir = path.dirname(file);
    const check = (target, lineNo) => {
      const t = target.trim();
      if (!t || /^#/.test(t) || t.includes('{{')) return;         // anchor / template
      if (/^(https?:|mailto:|tel:)/i.test(t) || /^\/\//.test(t)) return; // external
      const noFrag = t.split('#')[0];
      if (!noFrag) return;
      const resolved = path.resolve(dir, noFrag);
      if (!fs.existsSync(resolved)) addFinding({ stage: '3-links', severity: 'fail',
        file, line: lineNo,
        message: 'internal link does not resolve: "' + t + '" -> ' + resolved });
    };
    lines.forEach((line, i) => {
      for (const im of line.matchAll(inlineRe)) check(im[2], i + 1);
      const rm = line.match(refDefRe);
      if (rm) check(rm[2], i + 1);
    });
  }
}

/* ---- Stage 4: forbidden claims ------------------------------------------- */
function stageForbidden(mdList) {
  for (const file of mdList) {
    const lines = readLines(file);
    let inProtected = false, paragraph = '', start = 0;
    const flush = () => {
      paragraph = normalize(paragraph);
      if (!paragraph) return;
      for (const phrase of FORBIDDEN) {
        if (paragraph.includes(phrase)) addFinding({
          stage: '4-forbidden',
          severity: inProtected ? 'warn' : 'fail',
          file, line: start, inProtected,
          message: (inProtected
            ? 'forbidden claim cited inside protected section (verification): "'
            : 'forbidden/refuted claim found in affirmative prose: "') + phrase + '"',
        });
      }
      paragraph = '';
    };
    for (let i = 0; i < lines.length; i++) {
      const lm = lines[i].match(/^#{1,6}\s+(.+)$/);
      if (lm) { flush(); inProtected = PROTECTED_HEADING.test(lm[1]); continue; }
      if (lines[i].trim() === '') { flush(); continue; }
      if (!paragraph) start = i + 1;
      paragraph += ' ' + lines[i].trim();
    }
    flush();
  }
}

/* ---- Stage 5: placeholders ----------------------------------------------- */
function stagePlaceholders(mdList) {
  for (const file of mdList) {
    readLines(file).forEach((line, i) => {
      if (PLACEHOLDER_RE(line)) addFinding({ stage: '5-placeholders',
        severity: 'fail', file, line: i + 1,
        message: 'placeholder left in content: "' + line.trim().slice(0, 60) + '"' });
      if (HAS_OPEN_BRACE.test(line) && !/\}\}/.test(line)) addFinding({
        stage: '5-placeholders', severity: 'fail', file, line: i + 1,
        message: 'unclosed {{ placeholder on this line.' });
    });
  }
}

/* ---- CLI ---------------------------------------------------------------- */
function usage(code) {
  console.log([
    'Usage: node scripts/check-skill.mjs [options]', '',
    'Options:',
    '  --list               list all .md files under the skill and exit 0',
    '  --strict             treat WARNING-level findings as failures (exit 1)',
    '  -h, --help           show this help (exit 2)',
  ].join('\n'));
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const f of walkMds(ROOT)) console.log(path.relative(ROOT, f).replace(/\\/g, '/'));
  process.exit(0);
}
for (const a of args) {
  if (a === '-h' || a === '--help') usage(2);
  if (a !== '--strict') usage(2);
}
const STRICT = args.includes('--strict');

/* ---- run ---------------------------------------------------------------- */
const mdList = walkMds(ROOT);
const skillPath = path.join(ROOT, 'SKILL.md');
if (!fs.existsSync(skillPath)) addFinding({ stage: '0-layout', severity: 'fail',
  file: skillPath, message: 'SKILL.md not found at skill root.' });
if (!mdList.length) addFinding({ stage: '0-layout', severity: 'fail', file: ROOT,
  message: 'no .md files found under the skill.' });

const fm = fs.existsSync(skillPath) ? stageFrontmatter(skillPath) : null;
if (fm && fs.existsSync(skillPath)) {
  const body = fs.readFileSync(skillPath, 'utf8')
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').split(/\r?\n/);
  stageSections(skillPath, body);
}
stageLinks(mdList);
stageForbidden(mdList);
stagePlaceholders(mdList);

/* ---- report ------------------------------------------------------------- */
const STAGES = [
  ['1-frontmatter', 'Frontmatter validation'],
  ['2-sections', 'Mandatory section headings'],
  ['3-links', 'Internal relative links'],
  ['4-forbidden', 'Forbidden claims'],
  ['5-placeholders', 'Placeholders'],
];
const byStage = new Map(findings.map((f) => [f.stage, []]));
for (const f of findings) byStage.get(f.stage).push(f);

let fails = 0, warns = 0;
console.log('check-skill: ' + path.relative(process.cwd(), skillPath) + ' across ' +
  mdList.length + ' .md file(s)\n');
for (const [id, name] of STAGES) {
  const list = byStage.get(id) || [];
  const nFail = list.filter((f) => f.severity === 'fail').length;
  const nWarn = list.filter((f) => f.severity === 'warn').length;
  fails += nFail; warns += nWarn;
  console.log(ESC + '[1m' + name + ESC + '[0m — ' + nFail + ' fail(s), ' + nWarn + ' warning(s)');
  for (const f of list) {
    const rel = path.relative(ROOT, f.file).replace(/\\/g, '/');
    const loc = f.line ? rel + ':' + f.line : rel;
    const tag = f.severity === 'fail' ? ESC + '[31mFAIL' + ESC + '[0m'
      : ESC + '[33mWARN' + ESC + '[0m';
    console.log(tag + ' [' + id + '] ' + (f.severity === 'fail' ? '' : '(strict) ') + loc + ': ' + f.message);
  }
  console.log('');
}
console.log('Summary: ' + fails + ' failure(s), ' + warns + ' warning(s), ' + findings.length +
  ' total finding(s).');
const bad = fails > 0 || (STRICT && warns > 0);
console.log('RESULT: ' + (bad ? 'FAIL' : 'OK'));
process.exit(bad ? 1 : 0);
