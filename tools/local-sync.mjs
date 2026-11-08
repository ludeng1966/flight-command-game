import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const gitBinary = process.env.FLIGHT_SYNC_GIT || 'git';
const zeroSha = '0'.repeat(40);
const blockedParts = new Set(['.git', '.game-server', '.local-ai', 'node_modules', '__pycache__', '.venv', 'venv', 'build', 'dist', 'out']);

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function redact(value) {
  return String(value).replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{24,})\b/g, '[redacted]');
}

function git(root, args, options = {}) {
  try {
    return execFileSync(gitBinary, args, {
      cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 220 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], ...options,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_LITERAL_PATHSPECS: '1', ...(options.env || {}) },
    });
  } catch (error) {
    const failure = new SyncError('git_failed', `Git ${args[0]} 失败：${redact(error.stderr?.toString() || error.message).trim().slice(0, 900)}`);
    failure.exitStatus = error.status;
    throw failure;
  }
}

function tryGit(root, args) {
  try { return { ok: true, output: git(root, args).trim() }; }
  catch (error) { return { ok: false, error }; }
}

function paths(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const directory = path.join(path.resolve(root, common), 'flight-local-sync');
  fs.mkdirSync(directory, { recursive: true });
  return { directory, config: path.join(directory, 'config.json'), state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'lock.json'), stop: path.join(directory, 'stop.json'), log: path.join(directory, 'events.log') };
}

function readJson(filename, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filename);
}

function updateState(config, values) {
  const target = paths(config.root);
  const state = { ...readJson(target.state, {}), repository: config.repository, remote: config.remote,
    branch: config.branch, ...values, updatedAt: new Date().toISOString() };
  writeJson(target.state, state);
  return state;
}

function event(config, type, details = {}) {
  fs.appendFileSync(paths(config.root).log, JSON.stringify({ at: new Date().toISOString(), type, ...details }) + '\n');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function withLock(config, action) {
  const target = paths(config.root);
  const owner = { pid: process.pid, session: crypto.randomUUID(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(target.lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd); break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readJson(target.lock);
      if (previous && isAlive(previous.pid)) throw new SyncError('already_running', '这个仓库已有同步任务正在运行。');
      fs.unlinkSync(target.lock);
      if (attempt === 1) throw new SyncError('locked', '无法取得同步锁，请检查状态。');
    }
  }
  try { return await action(owner); }
  finally { if (readJson(target.lock)?.session === owner.session) fs.unlinkSync(target.lock); }
}

function names(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
}

function forbidden(filename) {
  const parts = filename.split('/');
  const basename = parts.at(-1);
  return parts.some(part => blockedParts.has(part)) ||
    (/^\.env(?:\.|$)/i.test(basename) && basename !== '.env.example') ||
    /\.(?:gguf|safetensors|ckpt|pth|onnx|wrpl|pem|p12|pfx)$/i.test(basename) || /vromfs\.bin/i.test(basename);
}

function included(config, filename) {
  return config.include.some(scope => scope.endsWith('/') ? filename.startsWith(scope) : filename === scope);
}

function validateRemote(config) {
  const url = git(config.root, ['remote', 'get-url', config.remote]).trim();
  if (config.allowLocalRemote) {
    if (path.resolve(url) !== config.localRemote) throw new SyncError('remote_changed', '测试远端已改变。');
    return;
  }
  const https = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/);
  const ssh = url.match(/^git@github\.com:([^/]+\/[^/]+?)\/?$/);
  const repository = (https?.[1] || ssh?.[1] || '').replace(/\.git$/, '');
  if (repository.toLowerCase() !== config.repository.toLowerCase()) {
    throw new SyncError('wrong_remote', '同步远端与已配置的小组仓库不一致，已停止上传。');
  }
}

export function initialize(root, options = {}) {
  root = fs.realpathSync(root);
  const top = fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (top !== root) throw new SyncError('not_root', '请从项目仓库根目录初始化。');
  const member = options.member;
  if (!member || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(member)) throw new SyncError('member_required', '请提供自己的 GitHub 用户名。');
  const branch = options.branch || `work/${member}/live-sync`;
  if (!branch.startsWith(`work/${member}/`) || !tryGit(root, ['check-ref-format', '--branch', branch]).ok) {
    throw new SyncError('bad_branch', '同步分支必须位于自己的 work/用户名/ 下。');
  }
  const target = paths(root);
  const previous = readJson(target.config);
  if (previous) {
    if (previous.member !== member || previous.branch !== branch) throw new SyncError('already_configured', '已有其他同步配置，请先查看状态。');
    validateRemote(previous); return previous;
  }
  const include = [...new Set(names(root).filter(name => !forbidden(name)).map(name => name.includes('/') ? name.split('/')[0] + '/' : name))];
  const config = { version: 1, root, member, branch, remote: options.remote || 'origin',
    repository: options.repository || 'ludeng1966/flight-command-game',
    email: options.email || `${member}@users.noreply.github.com`, include,
    pollMs: options.pollMs || 5000, quietMs: options.quietMs ?? 30000, retryMs: 30000,
    maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024,
    baseCommit: git(root, ['rev-parse', 'HEAD']).trim(),
    ...(options.allowLocalRemote ? { allowLocalRemote: true, localRemote: path.resolve(options.localRemote) } : {}) };
  validateRemote(config);
  writeJson(target.config, config);
  updateState(config, { phase: 'ready', message: '同步配置已保存，尚未启动。' });
  return config;
}

export function loadConfig(root) {
  const config = readJson(paths(root).config);
  if (!config) throw new SyncError('not_initialized', '尚未初始化本机同步。');
  if (fs.realpathSync(root) !== config.root) throw new SyncError('different_worktree', '请在初始化时的项目目录操作。');
  return config;
}

export function inspectWorking(config) {
  const rows = [git(config.root, ['rev-parse', 'HEAD']).trim(), JSON.stringify([...config.include].sort())];
  const allowed = [], pending = [], blocked = [];
  for (const name of names(config.root)) {
    let stat;
    try { stat = fs.lstatSync(path.join(config.root, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    rows.push([name, stat?.size ?? -1, stat?.mtimeMs ?? -1, stat?.ctimeMs ?? -1].join('\t'));
    if (forbidden(name)) { blocked.push(name); continue; }
    if (!included(config, name)) { pending.push(name); continue; }
    if (stat?.isSymbolicLink()) throw new SyncError('symlink', `暂不自动同步符号链接：${name}`);
    if (stat?.size > config.maxFileBytes) throw new SyncError('large_file', `文件超过自动同步大小限制：${name}`);
    allowed.push(name);
  }
  return { fingerprint: crypto.createHash('sha256').update(rows.join('\n')).digest('hex'), allowed, pending, blocked };
}

function checkSnapshot(config, indexGit) {
  const records = indexGit(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, sha, stage] = record.slice(0, tab).split(' ');
    if (stage !== '0' || mode === '160000') throw new SyncError('unsupported_index', '暂不自动同步冲突索引或子模块。');
    return { path: record.slice(tab + 1), sha };
  });
  const sizes = indexGit(['cat-file', '--batch-check=%(objectsize)'], { input: records.map(r => r.sha).join('\n') + '\n' }).trim().split('\n').map(Number);
  if (sizes.some(n => !Number.isFinite(n))) throw new SyncError('bad_object', '无法读取快照大小。');
  if (sizes.some(n => n > config.maxFileBytes) || sizes.reduce((sum, n) => sum + n, 0) > config.maxTotalBytes) {
    throw new SyncError('large_snapshot', '快照超出自动同步大小限制，请先检查大文件。');
  }
  const localSecrets = [];
  for (const entry of fs.readdirSync(config.root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\.env(?:\.|$)/i.test(entry.name) || entry.name === '.env.example') continue;
    for (const line of fs.readFileSync(path.join(config.root, entry.name), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(.+?)\s*$/i);
      if (match) { const value = match[1].replace(/^["']|["']$/g, ''); if (value.length >= 16) localSecrets.push(Buffer.from(value)); }
    }
  }
  const batch = indexGit(['cat-file', '--batch'], { encoding: null, input: records.map(r => r.sha).join('\n') + '\n' });
  let offset = 0;
  for (const entry of records) {
    const end = batch.indexOf(10, offset);
    const [sha, type, lengthText] = batch.subarray(offset, end).toString().split(' ');
    const length = Number(lengthText);
    if (sha !== entry.sha || type !== 'blob' || !Number.isSafeInteger(length)) throw new SyncError('bad_object', '快照对象不完整。');
    const body = batch.subarray(end + 1, end + 1 + length); offset = end + 1 + length + 1;
    const text = body.includes(0) ? '' : body.toString('utf8');
    if (forbidden(entry.path) || localSecrets.some(secret => body.includes(secret)) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,})\b/.test(text)) {
      throw new SyncError('secret_blocked', `快照检查未通过，未上传：${entry.path}`);
    }
  }
  return records.length;
}

function ensureBranchUnused(config) {
  if (git(config.root, ['worktree', 'list', '--porcelain']).split('\n').includes(`branch refs/heads/${config.branch}`)) {
    throw new SyncError('branch_checked_out', '个人同步分支正在某个工作目录中打开，请切回普通开发分支后再同步。');
  }
}

async function performSync(config, options = {}) {
  const target = paths(config.root);
  const ref = `refs/heads/${config.branch}`;
  const index = path.join(target.directory, `index-${process.pid}`);
  const indexGit = (args, extra = {}) => git(config.root, args, { ...extra, env: { GIT_INDEX_FILE: index } });
  updateState(config, { phase: 'syncing', lastAttempt: new Date().toISOString(), message: '正在保存并推送修改。' });
  try {
    validateRemote(config); ensureBranchUnused(config);
    const working = inspectWorking(config);
    if (working.blocked.length) throw new SyncError('excluded_file', `发现不应上传的文件，请加入忽略规则：${working.blocked[0]}`);
    const head = git(config.root, ['rev-parse', 'HEAD']).trim();
    let local = tryGit(config.root, ['rev-parse', '--verify', ref]).output || null;
    let remote = null, networkError = null;
    try {
      const output = git(config.root, ['ls-remote', config.remote, ref]).trim();
      remote = output ? output.split(/\s+/)[0] : null;
      if (remote) {
        git(config.root, ['fetch', '--no-tags', config.remote, `${ref}:refs/remotes/${config.remote}/${config.branch}`]);
        if (local && !tryGit(config.root, ['merge-base', '--is-ancestor', remote, local]).ok) {
          throw new SyncError('remote_changed', '远端个人分支出现其他修改，已暂停推送；请先检查并处理差异。');
        }
        if (!local) { git(config.root, ['update-ref', ref, remote, zeroSha]); local = remote; }
      }
    } catch (error) { if (error.code !== 'git_failed') throw error; networkError = error; }
    const parent = local || head;
    if (fs.existsSync(index)) fs.unlinkSync(index);
    indexGit(['read-tree', head]);
    const flags = new Map(git(config.root, ['ls-files', '-v', '-z']).split('\0').filter(Boolean).map(record => [record.slice(2), record[0].toUpperCase()]));
    const stage = working.allowed.filter(name => fs.existsSync(path.join(config.root, name)) || (flags.has(name) && flags.get(name) !== 'S'));
    if (stage.length) indexGit(['add', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: Buffer.from(stage.join('\0') + '\0') });
    options.afterStage?.();
    const fileCount = checkSnapshot(config, indexGit);
    if (git(config.root, ['rev-parse', 'HEAD']).trim() !== head || inspectWorking(config).fingerprint !== working.fingerprint) {
      throw new SyncError('editing', '文件仍在变化，等待下一轮稳定后再保存。');
    }
    const tree = indexGit(['write-tree']).trim();
    const parentTree = git(config.root, ['rev-parse', `${parent}^{tree}`]).trim();
    let commit = parent;
    if (tree !== parentTree) {
      const args = ['-c', `user.name=${config.member}`, '-c', `user.email=${config.email}`, 'commit-tree', tree, '-p', parent];
      if (head !== parent && !tryGit(config.root, ['merge-base', '--is-ancestor', head, parent]).ok) args.push('-p', head);
      args.push('-m', `WIP: local sync ${new Date().toISOString()}`);
      commit = indexGit(args).trim();
    }
    ensureBranchUnused(config);
    if (commit !== local) git(config.root, ['update-ref', ref, commit, local || zeroSha]);
    const changedFiles = git(config.root, ['diff', '--name-only', '-z', parentTree, tree]).split('\0').filter(Boolean).length;
    const queueBase = remote || readJson(target.state, {}).remoteCommit || config.baseCommit;
    const pendingCommits = commit === remote ? 0 : Number(git(config.root, ['rev-list', '--count', `${queueBase}..${commit}`]).trim());
    updateState(config, { localCommit: commit, fingerprint: working.fingerprint, fileCount, changedFiles,
      unapprovedPaths: working.pending, pendingUpload: commit !== remote, pendingCommits });
    if (networkError) throw networkError;
    if (commit !== remote) git(config.root, ['push', config.remote, `${commit}:${ref}`]);
    const confirmed = git(config.root, ['ls-remote', config.remote, ref]).trim().split(/\s+/)[0];
    if (confirmed !== commit) throw new SyncError('remote_changed', '推送后远端版本与本机快照不一致。');
    const state = updateState(config, { phase: 'synced', message: working.pending.length ? '已上传确认范围的修改，另有新路径待确认。' : '已同步到个人分支。',
      remoteCommit: commit, pendingUpload: false, pendingCommits: 0, lastSuccess: new Date().toISOString(), error: null });
    event(config, 'synced', { commit, fileCount, unapprovedPaths: working.pending });
    return state;
  } catch (error) {
    const phase = error.code === 'editing' ? 'waiting' : error.code === 'git_failed' ? 'offline' : 'blocked';
    updateState(config, { phase, message: error.message, error: error.code || 'unexpected' });
    event(config, phase, { message: redact(error.message), code: error.code });
    throw error;
  } finally {
    for (const filename of [index, index + '.lock']) if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
}

export async function syncOnce(config, options = {}) {
  return withLock(config, () => performSync(config, options));
}

export function getStatus(config) {
  const target = paths(config.root);
  const lock = readJson(target.lock);
  const running = Boolean(lock && isAlive(lock.pid));
  return { ...readJson(target.state, {}), running, pid: running ? lock.pid : null,
    configPath: target.config, logPath: target.log, sourceBranch: git(config.root, ['branch', '--show-current']).trim() };
}

export function requestStop(config) {
  const target = paths(config.root), owner = readJson(target.lock);
  if (!owner || !isAlive(owner.pid)) return { stopped: true, message: '同步程序未运行。' };
  writeJson(target.stop, { session: owner.session });
  return { stopped: false, message: '已请求停止，当前同步结束后退出。' };
}

export async function watch(config) {
  return withLock(config, async owner => {
    let stopping = false, seen = null, changedAt = Date.now(), nextRetry = 0;
    const stop = () => { stopping = true; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    updateState(config, { phase: 'watching', message: '监视已启动，等待文件稳定。' });
    event(config, 'started', { branch: config.branch, pid: process.pid });
    try {
      while (!stopping) {
        if (readJson(paths(config.root).stop)?.session === owner.session) break;
        try {
          const saved = readJson(paths(config.root).config);
          if (saved && Array.isArray(saved.include)) config.include = saved.include;
          const working = inspectWorking(config);
          if (working.fingerprint !== seen) { seen = working.fingerprint; changedAt = Date.now(); }
          const state = readJson(paths(config.root).state, {});
          const dirty = state.fingerprint !== seen;
          if (Date.now() >= nextRetry && ((dirty && Date.now() - changedAt >= config.quietMs) || state.pendingUpload)) {
            try { await performSync(config); }
            catch { /* Status and log retain the error; retry without discarding local snapshots. */ }
            nextRetry = Date.now() + config.retryMs;
          }
        } catch (error) {
          updateState(config, { phase: 'blocked', message: redact(error.message), error: error.code || 'unexpected' });
        }
        await new Promise(resolve => setTimeout(resolve, config.pollMs));
      }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      updateState(config, { phase: 'stopped', message: '同步监视已停止。' });
      event(config, 'stopped');
    }
  });
}

function argumentsOf(args) {
  const options = { command: args[0] || 'status' };
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--') || !args[i + 1]) throw new SyncError('arguments', '参数格式应为 --名称 值。');
    options[args[i].slice(2)] = args[++i];
  }
  return options;
}

export async function main(args) {
  const options = argumentsOf(args);
  const root = path.resolve(options.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  let result;
  if (options.command === 'init') result = initialize(root, options);
  else {
    const config = loadConfig(root);
    if (options.command === 'once') result = await syncOnce(config);
    else if (options.command === 'watch') result = await watch(config);
    else if (options.command === 'status') result = getStatus(config);
    else if (options.command === 'stop') result = requestStop(config);
    else if (options.command === 'approve') {
      const item = options.path?.replace(/\\/g, '/').replace(/\/$/, '');
      if (!item || item.split('/').some(part => !part || part === '..' || part === '.') || path.isAbsolute(item) || forbidden(item)) {
        throw new SyncError('bad_path', '请填写项目内可同步的相对路径。');
      }
      const full = path.join(config.root, item);
      if (!fs.existsSync(full)) throw new SyncError('missing_path', '待确认的路径不存在。');
      config.include = [...new Set([...config.include, item + (fs.statSync(full).isDirectory() ? '/' : '')])];
      writeJson(paths(root).config, config); result = { approved: item };
    } else throw new SyncError('command', '支持 init、once、watch、status、stop、approve。');
  }
  if (result) console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: error.code || 'unexpected', message: redact(error.message) })); process.exitCode = 1; });
}
