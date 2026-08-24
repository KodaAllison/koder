import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('generation keeps project links and drops projects whose folders were removed', t => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'koder-projects-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const codeDir = path.join(fixture, 'Code');
  const output = path.join(fixture, 'projects.json');
  const copiedScript = path.join(fixture, 'board', 'scripts', 'gen-projects.sh');
  mkdirSync(path.dirname(copiedScript), { recursive: true });
  mkdirSync(path.join(codeDir, 'keep'), { recursive: true });
  mkdirSync(path.join(codeDir, 'fresh'), { recursive: true });
  cpSync(path.join(root, 'scripts', 'gen-projects.sh'), copiedScript);
  writeFileSync(output, JSON.stringify({
    generated: 'old',
    projects: [
      {
        id: 'keep', name: 'keep', color: '#000', text: '#fff',
        repo: 'https://github.com/example/keep', url: 'https://keep.example',
      },
      { id: 'removed', name: 'removed', color: '#000', text: '#fff', repo: 'https://github.com/example/removed' },
    ],
  }));

  run(bash, [copiedScript], {
    env: {
      ...process.env,
      KODER_CODE_DIR: codeDir.replaceAll('\\', '/'),
      KODER_PROJECTS_FILE: output.replaceAll('\\', '/'),
    },
  });

  const generated = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(generated.projects.map(project => project.id), ['fresh', 'keep']);
  assert.deepEqual(
    { repo: generated.projects[1].repo, url: generated.projects[1].url },
    { repo: 'https://github.com/example/keep', url: 'https://keep.example' },
  );
  assert.equal('repo' in generated.projects[0], false);
  assert.equal(generated.projects.some(project => project.id === 'removed'), false);
});

test('default generation finds canonical Code from a linked worktree', t => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'koder-worktree-projects-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const codeDir = path.join(fixture, 'Code');
  const mainRepo = path.join(codeDir, 'koder');
  const linkedRepo = path.join(codeDir, 'koder-wt', 'project-links');
  const copiedScript = path.join(linkedRepo, 'scripts', 'gen-projects.sh');
  const output = path.join(linkedRepo, 'js', 'projects.json');
  mkdirSync(path.join(mainRepo, '.git'), { recursive: true });
  mkdirSync(path.join(codeDir, 'alpha-project'));
  mkdirSync(path.dirname(copiedScript), { recursive: true });
  mkdirSync(path.dirname(output));
  cpSync(path.join(root, 'scripts', 'gen-projects.sh'), copiedScript);
  run(bash, [copiedScript], {
    env: {
      ...process.env,
      KODER_GIT_COMMON_DIR: path.join(mainRepo, '.git').replaceAll('\\', '/'),
    },
  });

  const generated = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(generated.projects.map(project => project.id), ['alpha-project', 'koder']);
});
