// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'koder-ticket.sh');

/**
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, [script.replaceAll('\\', '/'), ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('delete and close parse as explicit DELETE commands', async t => {
  /** @type {{method: string|undefined, url: string|undefined, auth: string|undefined}[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      card: { id: 't_ticket_1a2b' },
      ref: 'KODER-1A2B',
      column: 'todo',
      rev: requests.length,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  const env = { KODER_API: `http://127.0.0.1:${port}`, KODER_TOKEN: 'test-token' };

  const deleted = await run(['delete', 'KODER-1A2B'], env);
  const closed = await run(['close', 't_ticket_1a2b'], env);

  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal(deleted.stdout.trim(), 'deleted KODER-1A2B (t_ticket_1a2b)');
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(closed.stdout.trim(), 'deleted KODER-1A2B (t_ticket_1a2b)');
  assert.deepEqual(requests, [
    { method: 'DELETE', url: '/tickets/KODER-1A2B', auth: 'Bearer test-token' },
    { method: 'DELETE', url: '/tickets/t_ticket_1a2b', auth: 'Bearer test-token' },
  ]);
});

test('delete rejects missing ids and extra arguments before making a request', async () => {
  const env = { KODER_API: 'http://127.0.0.1:1', KODER_TOKEN: 'test-token' };
  const missing = await run(['delete'], env);
  const extra = await run(['delete', 'KODER-1A2B', 'done'], env);

  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /usage: koder-ticket\.sh delete <ref\|id>/);
  assert.notEqual(extra.code, 0);
  assert.match(extra.stderr, /usage: koder-ticket\.sh delete <ref\|id>/);
});
