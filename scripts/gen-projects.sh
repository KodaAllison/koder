#!/usr/bin/env bash
#
# gen-projects.sh — regenerate js/projects.json from the folders in Code/.
#
# Override KODER_CODE_DIR and KODER_PROJECTS_FILE to generate from a fixture.
# Existing repo/url metadata is carried forward for folders that still exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${KODER_CODE_DIR:-}" ]]; then
  CODE_DIR="$KODER_CODE_DIR"
else
  COMMON_DIR="${KODER_GIT_COMMON_DIR:-$(git -C "$SCRIPT_DIR/.." rev-parse --path-format=absolute --git-common-dir)}"
  CODE_DIR="$(cd "$(dirname "$COMMON_DIR")/.." && pwd)"
fi
OUT_FILE="${KODER_PROJECTS_FILE:-$SCRIPT_DIR/../js/projects.json}"

node - "$CODE_DIR" "$OUT_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [codeDir, outFile] = process.argv.slice(2);
const colors = ['#eef1fe', '#d1fae5', '#fef3c7', '#fee2e2', '#e0f2fe', '#f3e8ff', '#ffe4e6', '#ccfbf1', '#fef9c3', '#ede9fe', '#fce7f3', '#dcfce7'];
const texts = ['#3b4bb8', '#047857', '#b45309', '#b91c1c', '#0369a1', '#7e22ce', '#be123c', '#0f766e', '#a16207', '#6d28d9', '#be185d', '#15803d'];
const skip = new Set(['node_modules', 'koder-phase1', 'koder-wt']);

function paletteIndex(name) {
  return [...name].reduce((sum, char) => sum + char.codePointAt(0), 0) % colors.length;
}

function generatedAt(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
  const offsetMinutes = pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetHours}${offsetMinutes}`;
}

let existing = { projects: [] };
if (fs.existsSync(outFile)) existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const metadata = new Map(
  (Array.isArray(existing.projects) ? existing.projects : []).map(project => [project.id, project]),
);

const names = fs.readdirSync(codeDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name))
  .map(entry => entry.name)
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b));

const projects = names.map(name => {
  const index = paletteIndex(name);
  const project = { id: name, name, color: colors[index], text: texts[index] };
  const previous = metadata.get(name);
  if (typeof previous?.repo === 'string' && previous.repo) project.repo = previous.repo;
  if (typeof previous?.url === 'string' && previous.url) project.url = previous.url;
  return project;
});

fs.writeFileSync(outFile, JSON.stringify({ generated: generatedAt(), projects }, null, 2) + '\n');
console.log(`wrote ${path.normalize(outFile)} (${projects.length} projects)`);
NODE
