#!/usr/bin/env node
/** Offline release installer. Nothing in a package is executed. Dry-run is the CLI default. */
import * as fs from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readZip} from '../js/archive.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'release-manifest.json', BACKUPS = '.update-backups', LOCK = '.update-lock';
const LIMIT = {maxEntries: 4096, maxEntryBytes: 128 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024};
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
const notFound = error => error.code === 'ENOENT';
const idPattern = /^\d{8}T\d{9}Z-[a-f0-9]{12}$/;
const timestampId = () => new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(6).toString('hex');
const within = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export function parseVersion(version) {
  if (typeof version !== 'string' || version.length > 128) throw new Error('版本必须是有效的 SemVer。');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[4]?.split('.').some(value => /^\d+$/.test(value) && value.length > 1 && value[0] === '0')) throw new Error(`无效的 SemVer：${version}`);
  return {parts: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') || []};
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1;
  if (!x.prerelease.length || !y.prerelease.length) return Number(!x.prerelease.length) - Number(!y.prerelease.length);
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const u = x.prerelease[i], v = y.prerelease[i];
    if (u === undefined || v === undefined) return u === undefined ? -1 : 1;
    if (u === v) continue;
    const un = /^\d+$/.test(u), vn = /^\d+$/.test(v);
    if (un && vn) return BigInt(u) > BigInt(v) ? 1 : -1;
    if (un !== vn) return un ? -1 : 1;
    return u > v ? 1 : -1;
  }
  return 0;
}

function safePath(name, {privatePath = false} = {}) {
  if (typeof name !== 'string' || !name || name.length > 1024 || name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name) || path.posix.isAbsolute(name)) throw new Error(`不安全的更新路径：${name}`);
  for (const segment of name.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) || !privatePath && segment.startsWith('.')) throw new Error(`不安全或保留的更新路径：${name}`);
  }
  return name;
}
function namespace(names) {
  const seen = new Map(), files = new Set(names);
  for (const name of names) {
    safePath(name);
    let prefix = '';
    for (const segment of name.split('/')) {
      prefix += (prefix ? '/' : '') + segment;
      const folded = prefix.toLowerCase();
      if (seen.has(folded) && seen.get(folded) !== prefix) throw new Error(`更新路径大小写冲突：${prefix}`);
      seen.set(folded, prefix);
      if (prefix !== name && files.has(prefix)) throw new Error(`更新文件与目录路径冲突：${prefix}`);
    }
  }
}
function parseJSON(bytes, label, max = 2 * 1024 * 1024) {
  if (bytes.length > max) throw new Error(`${label}超过大小限制。`);
  try { return JSON.parse(decoder.decode(bytes)); } catch { throw new Error(`${label}不是有效 UTF-8 JSON。`); }
}
function manifestFiles(manifest) {
  parseVersion(manifest?.version);
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMIT.maxEntries - 1) throw new Error('发布清单必须包含有界的 files 数组。');
  const files = new Map(); let total = 0;
  for (const file of manifest.files) {
    safePath(file?.path);
    if (file.path === MANIFEST || files.has(file.path) || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LIMIT.maxEntryBytes) throw new Error(`无效或重复的发布清单条目：${file?.path}`);
    if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) throw new Error(`文件权限无效：${file.path}`);
    total += file.bytes;
    if (total > LIMIT.maxTotalBytes) throw new Error('发布清单超过总大小限制。');
    files.set(file.path, {...file, sha256: file.sha256.toLowerCase()});
  }
  namespace([...files.keys(), MANIFEST]);
  return files;
}

/** archive.js validates CRC, sizes, duplicate paths and traversal. Additionally reject Unix link/special entries. */
function rejectArchiveLinks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('ZIP 中央目录无效。');
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const kind = (view.getUint32(at + 38, true) >>> 16) & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('更新 ZIP 不允许符号链接或特殊文件。');
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
}
export async function readRelease(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = await readZip(bytes, LIMIT);
  rejectArchiveLinks(bytes);
  const manifests = [...entries.keys()].filter(name => name === MANIFEST || name.endsWith('/' + MANIFEST));
  if (manifests.length !== 1) throw new Error('更新 ZIP 必须恰好包含一个 release-manifest.json。');
  const prefix = manifests[0].slice(0, -MANIFEST.length), payload = new Map();
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) throw new Error('ZIP 包含发布目录之外的额外文件。');
    const relative = safePath(name.slice(prefix.length));
    payload.set(relative, data);
  }
  namespace([...payload.keys()]);
  const manifestBytes = payload.get(MANIFEST), manifest = parseJSON(manifestBytes, '发布清单'), files = manifestFiles(manifest);
  if ([...payload.keys()].some(name => name !== MANIFEST && !files.has(name))) throw new Error('ZIP 含有清单未列出的文件（包括可执行文件）。');
  if (payload.size !== files.size + 1) throw new Error('ZIP 缺少发布清单列出的文件。');
  for (const [name, file] of files) {
    const data = payload.get(name);
    if (!data || data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`发布文件 SHA-256 或长度不匹配：${name}`);
  }
  if (!payload.has('package.json') || parseJSON(payload.get('package.json'), 'package.json').version !== manifest.version) throw new Error('package.json 版本必须与发布清单一致。');
  return {manifest, files, payload, packageSHA256: hash(bytes)};
}

async function rootFor(root) {
  const absolute = path.resolve(root), info = await fs.lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('项目根目录必须是普通目录，不能是链接。');
  return fs.realpath(absolute);
}
/** Check every component with lstat; never follow links below the explicitly selected project root. */
async function targetFor(root, relative, {privatePath = false} = {}) {
  safePath(relative, {privatePath});
  const target = path.resolve(root, ...relative.split('/'));
  if (!within(root, target) || target === root) throw new Error('更新路径越过项目根目录。');
  let current = root, missing = false;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (missing) continue;
    let info;
    try { info = await fs.lstat(current); } catch (error) { if (notFound(error)) { missing = true; continue; } throw error; }
    if (info.isSymbolicLink() || i < parts.length - 1 && !info.isDirectory()) throw new Error(`更新路径存在链接或非目录父级：${relative}`);
    if (i === parts.length - 1 && !info.isFile() && !info.isDirectory()) throw new Error(`更新目标不是普通文件：${relative}`);
  }
  return target;
}
async function snapshot(root, relative, options = {}) {
  const target = await targetFor(root, relative, options);
  try {
    const info = await fs.lstat(target);
    if (!info.isFile()) throw new Error(`更新目标已被目录占用：${relative}`);
    if (info.size > LIMIT.maxEntryBytes) throw new Error(`现有文件超过备份限制：${relative}`);
    const data = new Uint8Array(await fs.readFile(target));
    return {data, bytes: data.length, sha256: hash(data), mode: info.mode & 0o777};
  } catch (error) { if (notFound(error)) return null; throw error; }
}
async function installedManifest(root) {
  const current = await snapshot(root, MANIFEST);
  if (!current) throw new Error('项目缺少 release-manifest.json，不能安全确定旧版本及受管理文件。');
  const manifest = parseJSON(current.data, '当前发布清单');
  return {manifest, files: manifestFiles(manifest)};
}
async function planRelease(root, release) {
  const current = await installedManifest(root);
  if (compareVersions(release.manifest.version, current.manifest.version) <= 0) throw new Error(`更新版本 ${release.manifest.version} 必须高于当前版本 ${current.manifest.version}。降级请使用 --rollback。`);
  for (const name of ['scripts/apply-update.mjs', 'js/archive.js']) if (current.files.has(name) && !release.files.has(name)) throw new Error(`更新包不能移除离线回滚所需的文件：${name}`);
  const all = [...new Set([...current.files.keys(), ...release.files.keys(), MANIFEST])].sort();
  namespace(all);
  const changes = []; let backupBytes = 0;
  for (const name of all) {
    const before = await snapshot(root, name), data = release.payload.get(name), file = release.files.get(name);
    backupBytes += before?.bytes || 0;
    if (backupBytes > LIMIT.maxTotalBytes * 2) throw new Error('需要备份的现有文件超过 512 MiB。');
    const after = data ? {data, bytes: data.length, sha256: hash(data), mode: file?.mode ?? before?.mode ?? (name.endsWith('.sh') ? 0o755 : 0o644)} : null;
    const status = !before && after ? 'added' : before && !after ? 'deleted' : !before && !after || before.sha256 === after.sha256 && before.mode === after.mode ? 'unchanged' : 'modified';
    changes.push({path: name, status, before, after});
  }
  return {root, fromVersion: current.manifest.version, toVersion: release.manifest.version, packageSHA256: release.packageSHA256, changes};
}
export async function inspectUpdate({root = PROJECT, zipPath, bytes} = {}) {
  const resolved = await rootFor(root), release = await readRelease(bytes ?? await fs.readFile(zipPath));
  return planRelease(resolved, release);
}

async function ensureParents(root, relative, created, options = {}) {
  const target = await targetFor(root, relative, options), segments = relative.split('/').slice(0, -1); let current = root, rel = '';
  for (const segment of segments) {
    current = path.join(current, segment); rel += (rel ? '/' : '') + segment;
    try { await fs.mkdir(current, {mode: 0o700}); created?.push(rel); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`目标父目录不安全：${relative}`);
  }
  return target;
}
async function saveManifest(root, id, manifest, io) {
  const name = `${BACKUPS}/${id}/rollback.json`, target = await targetFor(root, name, {privatePath: true});
  const temp = target + '.new-' + randomBytes(4).toString('hex');
  await io.writeFile(temp, json(manifest), {flag: 'wx', mode: 0o600});
  try { await io.rename(temp, target); } finally { await io.unlink(temp).catch(error => { if (!notFound(error)) throw error; }); }
}
async function lockProject(root, action) {
  const target = await targetFor(root, LOCK, {privatePath: true}); let handle;
  try { handle = await fs.open(target, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('项目已有 .update-lock。请关闭另一个更新进程；确认没有进程运行后再移除遗留锁。'); throw error; }
  try { await handle.writeFile(`pid=${process.pid}\n`); return await action(); }
  finally { await handle.close(); await fs.unlink(target); }
}
const operations = io => ({writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, ...io});
async function cleanDirectories(root, names) {
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const target = await targetFor(root, name);
    await fs.rmdir(target).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
}
async function replaceTarget(root, entry, desired, stage, created, io, prepared = false) {
  const target = await ensureParents(root, entry.path, created);
  const current = await snapshot(root, entry.path);
  if (!desired) { if (current) await io.unlink(target); return; }
  const temporary = await targetFor(root, stage, {privatePath: true});
  if (!prepared) await io.writeFile(temporary, desired.data, {flag: 'wx', mode: desired.mode});
  try {
    await targetFor(root, entry.path); // Revalidate immediately before the mutation.
    await io.rename(temporary, target);
  } finally { await io.unlink(temporary).catch(error => { if (!notFound(error)) throw error; }); }
}
async function transaction(root, id, entries, desiredField, manifest, io, directoryHistory = []) {
  const changed = [], created = [], safety = [];
  // Preserve the complete pre-transaction state so a failed rollback can itself be rolled back.
  for (let i = 0; i < entries.length; i++) {
    const state = await snapshot(root, entries[i].path), storage = `${BACKUPS}/${id}/safety-${manifest.attempt}/${i}`;
    if (state) {
      const target = await ensureParents(root, storage, null, {privatePath: true});
      await io.writeFile(target, state.data, {flag: 'wx', mode: 0o600});
    }
    safety.push(state);
  }
  // Materialize every desired file before touching public files, so space/write errors fail early.
  for (let i = 0; i < entries.length; i++) {
    const desired = entries[i][desiredField];
    if (desired) {
      const staged = await targetFor(root, `${BACKUPS}/${id}/swap-${manifest.attempt}-${i}`, {privatePath: true});
      await io.writeFile(staged, desired.data, {flag: 'wx', mode: desired.mode});
    }
  }
  manifest.safety = entries.map((entry, i) => ({path: entry.path, storage: safety[i] ? `safety-${manifest.attempt}/${i}` : null, sha256: safety[i]?.sha256 ?? null}));
  await saveManifest(root, id, manifest, io);
  try {
    for (let i = 0; i < entries.length; i++) {
      // Mark first: failure after rename must still be included in compensation.
      changed.push(i);
      await replaceTarget(root, entries[i], entries[i][desiredField], `${BACKUPS}/${id}/swap-${manifest.attempt}-${i}`, created, io, true);
    }
    if (desiredField === 'before') await cleanDirectories(root, directoryHistory);
    manifest.createdDirectories = [...new Set([...(manifest.createdDirectories || []), ...created])];
    manifest.state = desiredField === 'before' ? 'rolled-back' : 'applied';
    if (desiredField === 'before') manifest.rolledBackAt = new Date().toISOString();
    else manifest.completedAt = new Date().toISOString();
    manifest.error = null; manifest.recoveryErrors = [];
    await saveManifest(root, id, manifest, io);
    return;
  } catch (error) {
    const failures = [];
    for (const i of changed.reverse()) {
      try { await replaceTarget(root, entries[i], safety[i], `${BACKUPS}/${id}/recover-${manifest.attempt}-${i}`, [], io); }
      catch (failure) { failures.push(`${entries[i].path}: ${failure.message}`); }
    }
    try { await cleanDirectories(root, created); } catch (failure) { failures.push(failure.message); }
    manifest.state = desiredField === 'before' ? 'rollback-failed' : 'apply-failed';
    manifest.error = error.message; manifest.recoveryErrors = failures;
    manifest.createdDirectories = [...new Set([...(manifest.createdDirectories || []), ...created])];
    await saveManifest(root, id, manifest, io).catch(failure => { failures.push(`清单保存失败：${failure.message}`); });
    throw new Error(`更新事务失败：${error.message}。${failures.length ? `自动恢复未全部完成：${failures.join('; ')}。` : '已恢复操作前文件。'}备份保留在 ${BACKUPS}/${id}；请保留该目录并使用 --rollback ${id} 重试。`);
  }
}

export async function applyUpdate({root = PROJECT, zipPath, bytes, io: suppliedIO} = {}) {
  root = await rootFor(root);
  const release = await readRelease(bytes ?? await fs.readFile(zipPath)), io = operations(suppliedIO);
  return lockProject(root, async () => {
    const plan = await planRelease(root, release), entries = plan.changes.filter(entry => entry.status !== 'unchanged'), id = timestampId();
    const backupDir = await ensureParents(root, `${BACKUPS}/${id}/rollback.json`, null, {privatePath: true});
    if (await fs.lstat(path.dirname(backupDir)).then(info => !info.isDirectory() || info.isSymbolicLink())) throw new Error('备份目录不安全。');
    const manifest = {format: 1, id, state: 'prepared', createdAt: new Date().toISOString(), fromVersion: plan.fromVersion, toVersion: plan.toVersion, packageSHA256: plan.packageSHA256, attempt: randomBytes(8).toString('hex'), createdDirectories: [],
      entries: entries.map((entry, i) => ({path: entry.path, before: entry.before ? {bytes: entry.before.bytes, sha256: entry.before.sha256, mode: entry.before.mode, storage: `before/${i}`} : null, after: entry.after ? {bytes: entry.after.bytes, sha256: entry.after.sha256, mode: entry.after.mode} : null}))};
    let backupBytes = 0;
    for (let i = 0; i < entries.length; i++) if (entries[i].before) {
      backupBytes += entries[i].before.bytes;
      if (backupBytes > LIMIT.maxTotalBytes * 2) throw new Error('旧文件备份超过大小限制。');
      const target = await ensureParents(root, `${BACKUPS}/${id}/before/${i}`, null, {privatePath: true});
      await io.writeFile(target, entries[i].before.data, {flag: 'wx', mode: 0o600});
    }
    await saveManifest(root, id, manifest, io);
    manifest.state = 'applying';
    try { await transaction(root, id, entries, 'after', manifest, io); }
    catch (error) { if (!error.message.includes(`${BACKUPS}/${id}`)) throw new Error(`${error.message}。项目文件尚未提交；备份保留在 ${BACKUPS}/${id}。`); throw error; }
    return {...plan, backupId: id};
  });
}

export async function rollbackUpdate({root = PROJECT, id, io: suppliedIO} = {}) {
  if (!idPattern.test(id || '')) throw new Error('回滚 ID 无效。');
  root = await rootFor(root); const io = operations(suppliedIO);
  return lockProject(root, async () => {
    const stored = await snapshot(root, `${BACKUPS}/${id}/rollback.json`, {privatePath: true});
    if (!stored) throw new Error(`找不到更新备份：${id}`);
    const manifest = parseJSON(stored.data, '回滚清单', 8 * 1024 * 1024);
    if (manifest.format !== 1 || manifest.id !== id || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > LIMIT.maxEntries * 2 || !['prepared', 'applying', 'applied', 'apply-failed', 'rolling-back', 'rollback-failed'].includes(manifest.state)) throw new Error('回滚清单无效，或此备份已经回滚。');
    namespace(manifest.entries.map(entry => entry.path));
    if (!Array.isArray(manifest.createdDirectories) || manifest.createdDirectories.length > LIMIT.maxEntries * 8) throw new Error('回滚目录清单无效。');
    for (const name of manifest.createdDirectories) safePath(name);
    const seen = new Set(), entries = []; let total = 0;
    for (let i = 0; i < manifest.entries.length; i++) {
      const entry = manifest.entries[i];
      if (seen.has(entry.path)) throw new Error('回滚清单有重复路径。'); seen.add(entry.path);
      let before = null;
      for (const state of [entry.before, entry.after]) if (state && (!/^[a-f0-9]{64}$/.test(state.sha256) || !Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > LIMIT.maxEntryBytes || !Number.isInteger(state.mode) || state.mode < 0 || state.mode > 0o777)) throw new Error('回滚文件元数据无效。');
      if (entry.before) {
        if (entry.before.storage !== `before/${i}`) throw new Error('回滚备份位置无效。');
        before = await snapshot(root, `${BACKUPS}/${id}/${entry.before.storage}`, {privatePath: true});
        if (!before || before.bytes !== entry.before.bytes || before.sha256 !== entry.before.sha256) throw new Error(`回滚备份 SHA-256 校验失败：${entry.path}`);
        before.mode = entry.before.mode; total += before.bytes;
        if (total > LIMIT.maxTotalBytes * 2) throw new Error('回滚文件超过大小限制。');
      }
      const current = await snapshot(root, entry.path), acceptable = [entry.before?.sha256, entry.after?.sha256];
      if (current && !acceptable.includes(current.sha256) || !current && entry.before && entry.after) throw new Error(`文件在更新后被修改或删除，拒绝覆盖：${entry.path}`);
      entries.push({path: entry.path, before, after: entry.after});
    }
    manifest.state = 'rolling-back'; manifest.attempt = randomBytes(8).toString('hex');
    await transaction(root, id, entries, 'before', manifest, io, manifest.createdDirectories);
    return {root, backupId: id, restoredVersion: manifest.fromVersion, changes: entries.length};
  });
}

const HELP = `本地离线更新（不下载、不执行更新包中的代码）\n\n先关闭本地服务器及编辑器，并保存作品。\n  node scripts/apply-update.mjs /path/release.zip                验证并预览；默认不写入\n  node scripts/apply-update.mjs /path/release.zip --apply        安装已验证的本地发布包\n  node scripts/apply-update.mjs --rollback BACKUP_ID             回滚指定备份\n  --root PATH                                                   指定项目目录（隔离测试用）\n\nZIP 必须含完整发布清单及所有列出的文件；每个文件必须通过 CRC/SHA-256。\n备份保留在 .update-backups/BACKUP_ID；本地服务器禁止访问隐藏目录。\n更新不会改动未被旧清单跟踪的本地作品；回滚拒绝覆盖更新后的手工修改。\n`;
export async function main(args = process.argv.slice(2)) {
  let root = PROJECT, zipPath, apply = false, rollback, dry = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); return; }
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dry = true;
    else if (arg === '--root' || arg === '--rollback') { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数。`); if (arg === '--root') root = value; else rollback = value; }
    else if (arg.startsWith('-') || zipPath) throw new Error(`未知或重复的参数：${arg}`);
    else zipPath = arg;
  }
  if (rollback) {
    if (apply || dry || zipPath) throw new Error('--rollback 不能与更新包、--apply 或 --dry-run 混用。');
    const result = await rollbackUpdate({root, id: rollback});
    process.stdout.write(`已回滚至 ${result.restoredVersion}；备份仍保留：${result.backupId}\n`); return;
  }
  if (!zipPath || apply && dry || /^[a-z][a-z0-9+.-]*:\/\//i.test(zipPath)) throw new Error('请选择本地 ZIP 文件。使用 --help 查看离线更新说明。');
  const plan = apply ? await applyUpdate({root, zipPath}) : await inspectUpdate({root, zipPath});
  process.stdout.write(`${apply ? '已安装' : '只读预览'} ${plan.fromVersion} → ${plan.toVersion}\nZIP SHA-256: ${plan.packageSHA256}\n`);
  for (const entry of plan.changes) process.stdout.write(`${({added: '+', modified: '~', deleted: '-', unchanged: '='})[entry.status]} ${entry.path}  SHA-256 ${(entry.after || entry.before)?.sha256 || '(不存在)'}\n`);
  process.stdout.write(apply ? `回滚命令：node scripts/apply-update.mjs --rollback ${plan.backupId}\n` : '尚未写入任何文件。确认预览后，添加 --apply 安装。\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`本地更新失败：${error.message}\n`); process.exitCode = 1; });
