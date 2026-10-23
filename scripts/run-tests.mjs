#!/usr/bin/env node
/** Pass real test paths to Node; never depend on shell or Node-version glob expansion. */
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function discoverTestFiles(root = projectRoot) {
  const files = ['tests', 'rust/tests'].flatMap(directory => readdirSync(path.join(root, directory), {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => `${directory}/${entry.name}`)).sort();
  if (!files.length) throw new Error('No JavaScript/WASM tests found.');
  return files;
}

export function runTests(args = process.argv.slice(2)) {
  const files = discoverTestFiles();
  if (args.length === 1 && args[0] === '--list') {
    process.stdout.write(files.join('\n') + '\n');
    return 0;
  }
  const result = spawnSync(process.execPath, ['--test', ...args, ...files], {cwd: projectRoot, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.signal) process.stderr.write(`Test runner terminated by ${result.signal}.\n`);
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runTests(); }
  catch (error) { process.stderr.write(`Unable to run tests: ${error.message}\n`); process.exitCode = 1; }
}
