import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeZip} from '../js/archive.js';
import {applyUpdate, inspectUpdate, rollbackUpdate, readRelease, compareVersions} from '../scripts/apply-update.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const cli = fileURLToPath(new URL('../scripts/apply-update.mjs', import.meta.url));
const oldFiles = {'package.json': encode({version: '1.0.0'}), 'js/app.js': encode('original JS'), 'old.txt': encode('old tracked file')};
const newFiles = {'package.json': encode({version: '1.1.0'}), 'js/app.js': encode('updated JS'), 'new/sub.txt': encode('new asset'), 'launch.sh': encode('#!/bin/sh\necho local\n')};
function manifest(version, files) { return {version, localOnly: true, files: Object.entries(files).map(([name, data]) => ({path: name, bytes: data.length, sha256: hash(data)}))}; }
async function archive(files = newFiles, {prefix = '', changeManifest, extra = []} = {}) {
  const release = manifest('1.1.0', files); changeManifest?.(release);
  return writeZip([...Object.entries(files).map(([name, data]) => ({name: prefix + name, data})), {name: prefix + 'release-manifest.json', data: encode(release)}, ...extra]);
}
async function fixture(t) {
  // Keep disposable roots beside the project: Windows sandbox virtual TEMP denies rename/junction operations.
  const fixtureParent = path.resolve(path.dirname(cli), '..');
  const dir = await fs.mkdtemp(path.join(fixtureParent, '.update-test-')), root = path.join(dir, 'project');
  await fs.mkdir(root);
  for (const [name, data] of Object.entries({...oldFiles, 'release-manifest.json': encode(manifest('1.0.0', oldFiles)), 'my-song.nbs': encode('untracked song')})) {
    await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true}); await fs.writeFile(path.join(root, name), data);
  }
  t.after(async () => {
    const resolved = path.resolve(dir), temporary = fixtureParent + path.sep;
    assert.ok(resolved.startsWith(temporary) && path.basename(resolved).startsWith('.update-test-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return {dir, root, bytes: await archive()};
}
async function publicState(root) {
  const result = {};
  async function walk(directory, prefix = '') {
    for (const item of await fs.readdir(directory, {withFileTypes: true})) {
      if (item.name.startsWith('.')) continue;
      const relative = prefix + item.name;
      if (item.isDirectory()) await walk(path.join(directory, item.name), relative + '/');
      else if (item.isFile()) result[relative] = (await fs.readFile(path.join(directory, item.name))).toString('base64');
    }
  }
  await walk(root); return result;
}
const readBackup = (root, id) => fs.readFile(path.join(root, '.update-backups', id, 'rollback.json'), 'utf8').then(JSON.parse);
const exists = target => fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function runCLI(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {windowsHide: true}); let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr}));
  });
}

test('SemVer ordering handles numeric segments, prereleases and build metadata without dependencies', () => {
  assert.equal(compareVersions('2.10.0', '2.9.99'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0+local', '1.0.0+other'), 0);
  assert.throws(() => compareVersions('01.0.0', '1.0.0'), /SemVer/);
  assert.throws(() => compareVersions('1.0.0-01', '1.0.0'), /SemVer/);
});
test('default CLI dry-run verifies SHA/changes and writes nothing, including no backup or lock', async t => {
  const {dir, root, bytes} = await fixture(t), zipPath = path.join(dir, 'release.zip'), before = await publicState(root);
  await fs.writeFile(zipPath, bytes);
  const result = await runCLI([zipPath, '--root', root]);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /只读预览 1\.0\.0 → 1\.1\.0/);
  assert.match(result.stdout, new RegExp(hash(bytes))); assert.match(result.stdout, /\+ new\/sub\.txt/); assert.match(result.stdout, /- old\.txt/);
  assert.deepEqual(await publicState(root), before); assert.equal(await exists(path.join(root, '.update-backups')), false); assert.equal(await exists(path.join(root, '.update-lock')), false);
  const wrapped = await archive(newFiles, {prefix: 'NoteBlockStudio-Web/'});
  assert.equal((await inspectUpdate({root, bytes: wrapped})).toVersion, '1.1.0');
});
test('apply and rollback restore exact original files, delete additions, and preserve local untracked work', async t => {
  const {root, bytes} = await fixture(t), original = await publicState(root);
  const installed = await applyUpdate({root, bytes});
  assert.equal(await fs.readFile(path.join(root, 'js/app.js'), 'utf8'), 'updated JS');
  assert.equal(await exists(path.join(root, 'old.txt')), false); assert.equal(await fs.readFile(path.join(root, 'my-song.nbs'), 'utf8'), 'untracked song');
  assert.equal(await fs.readFile(path.join(root, 'new/sub.txt'), 'utf8'), 'new asset');
  const backup = await readBackup(root, installed.backupId); assert.equal(backup.state, 'applied'); assert.equal(backup.packageSHA256, hash(bytes));
  for (const entry of backup.entries) if (entry.before) assert.equal(hash(await fs.readFile(path.join(root, '.update-backups', installed.backupId, entry.before.storage))), entry.before.sha256);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'launch.sh'))).mode & 0o777, 0o755);
  await rollbackUpdate({root, id: installed.backupId});
  assert.deepEqual(await publicState(root), original); assert.equal(await exists(path.join(root, 'new')), false);
  assert.equal((await readBackup(root, installed.backupId)).state, 'rolled-back');
  await assert.rejects(rollbackUpdate({root, id: installed.backupId}), /已经回滚/);
});
test('bad payload hashes, unavailable entries, unlisted executable and version mismatch fail before writes', async t => {
  const {root} = await fixture(t), original = await publicState(root);
  const bad = await archive(newFiles, {changeManifest: value => { value.files[0].sha256 = '0'.repeat(64); }});
  await assert.rejects(applyUpdate({root, bytes: bad}), /SHA-256/);
  const missing = await archive(newFiles, {changeManifest: value => { value.files.push({path: 'missing.js', bytes: 1, sha256: '0'.repeat(64)}); }});
  await assert.rejects(readRelease(missing), /缺少发布清单/);
  await assert.rejects(readRelease(await archive(newFiles, {extra: [{name: 'surprise.exe', data: 'not executed'}]})), /清单未列出/);
  await assert.rejects(readRelease(await archive(newFiles, {changeManifest: value => { value.version = '1.2.0'; }})), /版本必须与/);
  const oldVersion = {...newFiles, 'package.json': encode({version: '1.0.0'})};
  await assert.rejects(inspectUpdate({root, bytes: await archive(oldVersion, {changeManifest: value => { value.version = '1.0.0'; }})}), /必须高于/);
  assert.deepEqual(await publicState(root), original); assert.equal(await exists(path.join(root, '.update-backups')), false);
});
test('ZIP duplicate, traversal, case aliases and symlink entry metadata are rejected', async () => {
  const duplicate = new Uint8Array(await writeZip([{name: 'aa', data: 'a'}, {name: 'bb', data: 'b'}]));
  const duplicateView = new DataView(duplicate.buffer);
  for (let i = 0; i < duplicate.length - 46; i++) if (duplicateView.getUint32(i, true) === 0x02014b50 && duplicate[i + 46] === 98) duplicate.set(encode('aa'), i + 46);
  await assert.rejects(readRelease(duplicate), /重复/);
  const traversal = new Uint8Array(await writeZip([{name: 'xx/x', data: 'x'}]));
  const traversalView = new DataView(traversal.buffer);
  for (let i = 0; i < traversal.length - 4; i++) {
    const signature = traversalView.getUint32(i, true);
    if (signature === 0x02014b50) traversal.set(encode('../x'), i + 46);
    if (signature === 0x04034b50) traversal.set(encode('../x'), i + 30);
  }
  await assert.rejects(readRelease(traversal), /不安全/);
  await assert.rejects(readRelease(await archive({...newFiles, 'JS/extra.js': encode('case alias')})), /大小写冲突/);
  const link = new Uint8Array(await archive()), linkView = new DataView(link.buffer);
  for (let i = 0; i < link.length - 46; i++) if (linkView.getUint32(i, true) === 0x02014b50) { linkView.setUint32(i + 38, (0xa1ff << 16) >>> 0, true); break; }
  await assert.rejects(readRelease(link), /符号链接/);
});
test('filesystem parent links and a linked backup folder cannot redirect updater writes', async t => {
  const {dir, root, bytes} = await fixture(t), outside = path.join(dir, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside');
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('OS sandbox denies creating test links; run this test outside that sandbox to verify filesystem links. ZIP link rejection remains covered.'); return; } throw error; }
  const linkedPayload = await archive({...newFiles, 'linked/escape.txt': encode('escape')});
  await assert.rejects(applyUpdate({root, bytes: linkedPayload}), /链接/);
  assert.equal(await exists(path.join(outside, 'escape.txt')), false);
  await fs.symlink(outside, path.join(root, '.update-backups'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyUpdate({root, bytes}), /链接/);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
  assert.deepEqual((await fs.readdir(outside)).sort(), ['sentinel.txt']);
});
test('CLI explicit apply and rollback work only on the disposable --root', async t => {
  const {dir, root, bytes} = await fixture(t), original = await publicState(root), zipPath = path.join(dir, 'release.zip'); await fs.writeFile(zipPath, bytes);
  const installed = await runCLI([zipPath, '--apply', '--root', root]); assert.equal(installed.code, 0, installed.stderr); assert.match(installed.stdout, /已安装/);
  const [id] = await fs.readdir(path.join(root, '.update-backups'));
  const restored = await runCLI(['--rollback', id, '--root', root]); assert.equal(restored.code, 0, restored.stderr); assert.match(restored.stdout, /已回滚至 1\.0\.0/);
  assert.deepEqual(await publicState(root), original);
  const remote = await runCLI(['https://example.invalid/release.zip', '--root', root]); assert.equal(remote.code, 1); assert.match(remote.stderr, /本地 ZIP/);
});
test('manifest bounds and reserved paths cannot write into updater metadata', async t => {
  const {root} = await fixture(t), original = await publicState(root);
  await assert.rejects(readRelease(await archive(newFiles, {changeManifest: value => { value.files[0].bytes = 129 * 1024 * 1024; }})), /清单条目/);
  await assert.rejects(readRelease(await archive(newFiles, {changeManifest: value => { value.files = Array.from({length: 4096}, (_, i) => ({path: `file${i}`, bytes: 0, sha256: hash('')})); }})), /有界/);
  await assert.rejects(readRelease(await archive({...newFiles, '.update-backups/escape': encode('no')})), /保留|不安全/);
  await fs.writeFile(path.join(root, '.update-lock'), 'another update');
  await assert.rejects(applyUpdate({root, bytes: await archive()}), /已有 .update-lock/);
  assert.deepEqual(await publicState(root), original);
});
test('a mid-apply rename failure compensates every write and keeps verified rollback bytes', async t => {
  const {root, bytes} = await fixture(t), original = await publicState(root); let failed = false;
  await assert.rejects(applyUpdate({root, bytes, io: {rename: async (from, to) => {
    if (!failed && to === path.join(root, 'package.json')) { failed = true; throw new Error('injected rename failure'); }
    return fs.rename(from, to);
  }}}), /已恢复操作前文件/);
  assert.deepEqual(await publicState(root), original); assert.equal(await exists(path.join(root, '.update-lock')), false);
  const [id] = await fs.readdir(path.join(root, '.update-backups')), backup = await readBackup(root, id);
  assert.equal(backup.state, 'apply-failed'); assert.deepEqual(backup.recoveryErrors, []);
  for (const entry of backup.entries) if (entry.before) assert.equal(hash(await fs.readFile(path.join(root, '.update-backups', id, entry.before.storage))), entry.before.sha256);
  await rollbackUpdate({root, id}); assert.deepEqual(await publicState(root), original);
});
test('staging failure occurs before any public mutation', async t => {
  const {root, bytes} = await fixture(t), original = await publicState(root);
  await assert.rejects(applyUpdate({root, bytes, io: {writeFile: async (target, ...args) => {
    if (path.basename(target).startsWith('swap-') && path.basename(target).endsWith('-1')) throw new Error('simulated full disk');
    return fs.writeFile(target, ...args);
  }}}), /simulated full disk/);
  assert.deepEqual(await publicState(root), original); assert.equal(await exists(path.join(root, '.update-lock')), false);
});
test('rollback refuses edited installed files and corrupted backups without changing project bytes', async t => {
  const {root, bytes} = await fixture(t), installed = await applyUpdate({root, bytes});
  await fs.writeFile(path.join(root, 'js/app.js'), 'my local changes'); const edited = await publicState(root);
  await assert.rejects(rollbackUpdate({root, id: installed.backupId}), /被修改/); assert.deepEqual(await publicState(root), edited);
  await fs.writeFile(path.join(root, 'js/app.js'), newFiles['js/app.js']);
  const backup = await readBackup(root, installed.backupId), entry = backup.entries.find(entry => entry.path === 'js/app.js');
  await fs.writeFile(path.join(root, '.update-backups', installed.backupId, entry.before.storage), 'corrupted backup');
  const before = await publicState(root); await assert.rejects(rollbackUpdate({root, id: installed.backupId}), /备份 SHA-256/); assert.deepEqual(await publicState(root), before);
});
test('rollback failure restores the updated project and preserves backup/retry state', async t => {
  const {root, bytes} = await fixture(t), original = await publicState(root), installed = await applyUpdate({root, bytes}), updated = await publicState(root); let failed = false;
  await assert.rejects(rollbackUpdate({root, id: installed.backupId, io: {rename: async (from, to) => {
    if (!failed && to === path.join(root, 'package.json')) { failed = true; throw new Error('injected rollback failure'); }
    return fs.rename(from, to);
  }}}), /已恢复操作前文件/);
  assert.deepEqual(await publicState(root), updated);
  const backup = await readBackup(root, installed.backupId); assert.equal(backup.state, 'rollback-failed'); assert.deepEqual(backup.recoveryErrors, []);
  for (const entry of backup.entries) if (entry.before) assert.equal(hash(await fs.readFile(path.join(root, '.update-backups', installed.backupId, entry.before.storage))), entry.before.sha256);
  assert.ok(backup.safety.length > 0); assert.equal(await exists(path.join(root, '.update-lock')), false);
  await rollbackUpdate({root, id: installed.backupId}); assert.deepEqual(await publicState(root), original);
});
test('rollback compensation failure retains recoverable originals and can be retried', async t => {
  const {root, bytes} = await fixture(t), original = await publicState(root), installed = await applyUpdate({root, bytes}); let triggered = false;
  await assert.rejects(rollbackUpdate({root, id: installed.backupId, io: {rename: async (from, to) => {
    if (!triggered && to === path.join(root, 'package.json')) { triggered = true; throw new Error('rollback write failure'); }
    if (triggered && path.basename(from).startsWith('recover-') && to === path.join(root, 'js/app.js')) throw new Error('compensation write failure');
    return fs.rename(from, to);
  }}}), /自动恢复未全部完成/);
  const backup = await readBackup(root, installed.backupId); assert.equal(backup.state, 'rollback-failed'); assert.equal(backup.recoveryErrors.length, 1);
  for (const entry of backup.entries) if (entry.before) assert.equal(hash(await fs.readFile(path.join(root, '.update-backups', installed.backupId, entry.before.storage))), entry.before.sha256);
  await rollbackUpdate({root, id: installed.backupId}); assert.deepEqual(await publicState(root), original);
});
