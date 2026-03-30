import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'src', 'index.js');

async function run(...args) {
  try {
    const { stdout, stderr } = await exec('node', [cli, ...args], {
      timeout: 10000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.code };
  }
}

describe('CLI smoke tests', () => {
  it('--version prints version number', async () => {
    const { stdout, code } = await run('--version');
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('--help shows command list', async () => {
    const { stdout, code } = await run('--help');
    assert.equal(code, 0);
    assert.ok(stdout.includes('init'), 'should list init command');
    assert.ok(stdout.includes('import'), 'should list import command');
    assert.ok(stdout.includes('send'), 'should list send command');
    assert.ok(stdout.includes('status'), 'should list status command');
    assert.ok(stdout.includes('delete'), 'should list delete command');
    assert.ok(stdout.includes('config'), 'should list config command');
  });

  it('config command prints a path', async () => {
    const { stdout, code } = await run('config');
    assert.equal(code, 0);
    assert.ok(stdout.includes('config.json'), 'should print config file path');
  });

  it('import without --csv exits with error', async () => {
    const { stderr, code } = await run('import', 'test-group');
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('--csv'), 'should mention missing --csv option');
  });

  it('send without --template exits with error', async () => {
    const { stderr, code } = await run('send', 'test-group');
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('--template'), 'should mention missing --template option');
  });

  it('unknown command shows error', async () => {
    const { stderr, code } = await run('nonexistent');
    assert.notEqual(code, 0);
  });
});
