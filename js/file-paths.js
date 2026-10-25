/** Compare opaque local-file references without accessing a filesystem or resolving a URL. */
const URI_SCHEME = /^(?:https?|file|data|blob|javascript|vbscript|ftp|ftps|mailto|wss?|about|nbs):/i;

export function localFileKey(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const path = value.replace(/\\/g, '/');
  // Do not turn URL escapes, parent segments or remote references into local sample aliases.
  if (URI_SCHEME.test(path) || path.includes('://') || path.split('/').includes('..')) return null;
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const parts = path.split('/').filter(part => part && part !== '.');
  if (!parts.length || path.endsWith('/') || path.endsWith('/.')) return null;
  if (!prefix && /^[a-z]:\//i.test(path)) parts[0] = parts[0].toLowerCase();
  return prefix + parts.join('/');
}

/** Exact case-sensitive paths win. Compatibility fallbacks report every candidate. */
export function matchLocalFileReferences(value, references, {allowBasename = false} = {}) {
  const key = localFileKey(value);
  if (!key) return {indices: [], kind: null};
  const keys = references.map(localFileKey);
  const find = predicate => keys.flatMap((candidate, index) => candidate && predicate(candidate) ? [index] : []);
  let indices = find(candidate => candidate === key);
  if (indices.length) return {indices, kind: 'exact'};
  const folded = key.toLowerCase();
  indices = find(candidate => candidate.toLowerCase() === folded);
  if (indices.length) return {indices, kind: 'case'};
  if (allowBasename) {
    const leaf = folded.split('/').at(-1);
    indices = find(candidate => candidate.split('/').at(-1).toLowerCase() === leaf);
    if (indices.length) return {indices, kind: 'basename'};
  }
  return {indices: [], kind: null};
}

/** Used only after the user has selected a local file; never guess between sample definitions. */
export function findLocalFileReference(value, references, options) {
  const {indices} = matchLocalFileReferences(value, references, options);
  if (indices.length > 1) throw new Error('音色文件路径存在歧义：多个音色引用了同名或大小写不同的文件。请在音色管理中选择目标音色后重新载入。');
  return indices[0] ?? -1;
}
