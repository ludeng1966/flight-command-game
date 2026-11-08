import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialize, syncOnce, getStatus, requestStop, watch, main } from '../tools/local-sync.mjs';

const gitBinary = process.env.FLIGHT_SYNC_GIT || 'git';
function git(root, ...args) {
  return execFileSync(gitBinary, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.missing-global-config'), GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function put(root, filename, text) { const target = path.join(root, filename); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-sync-test-'));
  const root = path.join(directory, 'source'), remote = path.join(directory, 'remote.git');
  fs.mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'test-member'); git(root, 'config', 'user.email', 'test@example.invalid');
  put(root, '.gitignore', '.env\n.game-server/\n');
  put(root, 'src/main.js', 'export const value = 1;\n'); put(root, 'other/sparse.txt', 'preserve this\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  git(root, 'init', '--bare', remote); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'main');
  const config = initialize(root, { member: 'tester', email: 'test@example.invalid', remote: 'origin',
    allowLocalRemote: true, localRemote: remote, quietMs: 0, pollMs: 10 });
  return { directory, root, remote, config, head: git(root, 'rev-parse', 'HEAD') };
}

test('snapshots saved files and new files while preserving HEAD, index and remote main', async () => {
  const f = fixture();
  put(f.root, 'src/staged.js', 'const staged = 1;\n'); git(f.root, 'add', 'src/staged.js');
  put(f.root, 'src/main.js', 'export const value = 2;\n');
  put(f.root, 'src/new.js', 'export const extra = true;\n');
  put(f.root, '.env', 'API_KEY=private-test-value-that-must-stay-local\n');
  put(f.root, '.game-server/run.log', 'local runtime log');
  const originalIndex = fs.readFileSync(path.join(f.root, '.git/index'));
  const state = await syncOnce(f.config);
  assert.equal(state.phase, 'synced'); assert.equal(state.pendingCommits, 0);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), originalIndex);
  assert.equal(git(f.root, 'show', state.localCommit + ':src/main.js'), 'export const value = 2;');
  assert.equal(git(f.root, 'show', state.localCommit + ':src/new.js'), 'export const extra = true;');
  assert.equal(git(f.root, 'ls-tree', '--name-only', state.localCommit, '.env', '.game-server'), '');
  assert.equal(git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], f.head);
  const second = await syncOnce(f.config);
  assert.equal(second.localCommit, state.localCommit, 'unchanged files must not produce duplicate commits');
});

test('offline snapshots are retained and retried without creating duplicate commits', async () => {
  const f = fixture();
  put(f.root, 'src/main.js', 'export const value = 3;\n');
  const offline = path.join(f.directory, 'offline.git');
  // Both resolved move targets are inside the explicitly created test directory.
  for (const target of [f.remote, offline]) assert.ok(path.resolve(target).startsWith(path.resolve(f.directory) + path.sep));
  fs.renameSync(f.remote, offline);
  await assert.rejects(syncOnce(f.config), error => error.code === 'git_failed');
  const pending = getStatus(f.config);
  assert.equal(pending.phase, 'offline'); assert.equal(pending.pendingUpload, true); assert.equal(pending.pendingCommits, 1);
  assert.ok(pending.localCommit);
  fs.renameSync(offline, f.remote);
  const retried = await syncOnce(f.config);
  assert.equal(retried.localCommit, pending.localCommit); assert.equal(retried.pendingUpload, false);
});

test('a second writer on the remote branch pauses upload without overwriting it', async () => {
  const f = fixture();
  put(f.root, 'src/main.js', 'export const value = 4;\n');
  const first = await syncOnce(f.config);
  const other = path.join(f.directory, 'second-writer');
  git(f.root, 'clone', '--branch', f.config.branch, f.remote, other);
  git(other, 'config', 'user.name', 'other'); git(other, 'config', 'user.email', 'other@example.invalid');
  put(other, 'src/main.js', 'export const other = true;\n'); git(other, 'add', '.'); git(other, 'commit', '-m', 'remote change');
  git(other, 'push', 'origin', 'HEAD');
  const remoteHead = git(other, 'rev-parse', 'HEAD');
  put(f.root, 'src/main.js', 'export const local = true;\n');
  await assert.rejects(syncOnce(f.config), error => error.code === 'remote_changed');
  assert.equal(getStatus(f.config).phase, 'blocked');
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + f.config.branch), first.localCommit);
  assert.equal(git(f.root, 'ls-remote', 'origin', 'refs/heads/' + f.config.branch).split(/\s+/)[0], remoteHead);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/main.js'), 'utf8'), 'export const local = true;\n');
});

test('configured secrets are rejected without exposing their values in status or logs', async () => {
  const f = fixture();
  const secret = 'private-config-' + 'x'.repeat(30);
  put(f.root, '.env', 'SERVICE_API_KEY=' + secret + '\n');
  put(f.root, 'src/main.js', 'export const key = "' + secret + '";\n');
  await assert.rejects(syncOnce(f.config), error => error.code === 'secret_blocked' && !error.message.includes(secret));
  const state = getStatus(f.config);
  assert.equal(state.phase, 'blocked'); assert.ok(!JSON.stringify(state).includes(secret));
  assert.ok(!fs.readFileSync(state.logPath, 'utf8').includes(secret));
  assert.equal(git(f.root, 'ls-remote', 'origin', 'refs/heads/' + f.config.branch), '');
});

test('sparse missing files stay in the snapshot and new root paths await approval', async () => {
  const f = fixture();
  git(f.root, 'update-index', '--skip-worktree', 'other/sparse.txt');
  fs.unlinkSync(path.join(f.root, 'other/sparse.txt'));
  put(f.root, 'src/main.js', 'export const value = 5;\n');
  put(f.root, 'new-root/unapproved.js', 'must wait for scope approval\n');
  const state = await syncOnce(f.config);
  assert.equal(git(f.root, 'show', state.localCommit + ':other/sparse.txt'), 'preserve this');
  assert.deepEqual(state.unapprovedPaths, ['new-root/unapproved.js']);
  assert.equal(git(f.root, 'ls-tree', '--name-only', state.localCommit, 'new-root'), '');
});

test('edits made during snapshot construction are retried without publishing a partial snapshot', async () => {
  const f = fixture();
  put(f.root, 'src/main.js', 'export const before = true;\n');
  await assert.rejects(syncOnce(f.config, { afterStage: () => put(f.root, 'src/main.js', 'export const after = true;\n') }),
    error => error.code === 'editing');
  assert.equal(git(f.root, 'ls-remote', 'origin', 'refs/heads/' + f.config.branch), '');
  const state = await syncOnce(f.config);
  assert.equal(git(f.root, 'show', state.localCommit + ':src/main.js'), 'export const after = true;');
});

test('the destination branch cannot be main or a checked-out branch', async () => {
  const f = fixture();
  assert.throws(() => initialize(f.root, { member: 'tester', branch: 'main' }), error => error.code === 'bad_branch');
  git(f.root, 'update-ref', 'refs/heads/' + f.config.branch, f.head);
  git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/' + f.config.branch);
  await assert.rejects(syncOnce(f.config), error => error.code === 'branch_checked_out');
});

test('the watcher uploads changes, prevents a second instance and stops on request', async () => {
  const f = fixture();
  put(f.root, 'src/main.js', 'export const watched = true;\n');
  const task = watch(f.config);
  const deadline = Date.now() + 10000;
  try {
    while (!getStatus(f.config).lastSuccess && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const status = getStatus(f.config);
    assert.equal(status.running, true); assert.equal(status.phase, 'synced');
    await assert.rejects(syncOnce(f.config), error => error.code === 'already_running');
    assert.equal(requestStop(f.config).stopped, false);
  } finally {
    requestStop(f.config);
    await task;
  }
  assert.equal(getStatus(f.config).running, false);
  assert.equal(getStatus(f.config).phase, 'stopped');
});

test('approving a new path is picked up by an already-running watcher', async () => {
  const f = fixture();
  f.config.retryMs = 30;
  put(f.root, 'src/main.js', 'export const watched = true;\n');
  put(f.root, 'new-root/approved.js', 'export const approved = true;\n');
  const task = watch(f.config);
  try {
    const firstDeadline = Date.now() + 10000;
    while (!getStatus(f.config).lastSuccess && Date.now() < firstDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(getStatus(f.config).unapprovedPaths, ['new-root/approved.js']);
    await main(['approve', '--root', f.root, '--path', 'new-root']);
    const nextDeadline = Date.now() + 10000;
    while (getStatus(f.config).unapprovedPaths.length && Date.now() < nextDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    const state = getStatus(f.config);
    assert.deepEqual(state.unapprovedPaths, []);
    assert.equal(git(f.root, 'show', state.localCommit + ':new-root/approved.js'), 'export const approved = true;');
  } finally { requestStop(f.config); await task; }
});
