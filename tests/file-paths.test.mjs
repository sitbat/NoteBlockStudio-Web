import test from 'node:test';
import assert from 'node:assert/strict';
import {localFileKey,matchLocalFileReferences,findLocalFileReference} from '../js/file-paths.js';

test('opaque sample references normalize POSIX, Windows and safe relative separators without changing filename case', () => {
  for (const [input, expected] of [
    ['./Custom\\Piano.ogg','Custom/Piano.ogg'],
    ['sounds//./piano.ogg','sounds/piano.ogg'],
    ['C:\\fakepath\\Piano.ogg','c:/fakepath/Piano.ogg'],
    ['/home/user/sounds/Piano.ogg','/home/user/sounds/Piano.ogg'],
    ['\\\\server\\share\\Piano.ogg','//server/share/Piano.ogg'],
    ['mix:take.ogg','mix:take.ogg'],
    ['/C:/Piano.ogg','/C:/Piano.ogg'],
    ['sounds/%2e%2e.ogg','sounds/%2e%2e.ogg'],
  ]) assert.equal(localFileKey(input), expected);
});

test('automatic aliases reject parent traversal, URLs, controls and directory references', () => {
  for (const value of ['',null,{},'../piano.ogg','sounds/../piano.ogg','sounds\\..\\piano.ogg',
    'https://example.org/piano.ogg','file:///home/user/piano.ogg','data:audio/ogg;base64,AA',
    'blob:https://example.org/id','http:piano.ogg','sftp://host/piano.ogg',
    'piano\u0000.ogg','piano\n.ogg','sounds/','sounds/.','./','/','a'.repeat(4097)]) {
    assert.equal(localFileKey(value), null, String(value));
    assert.equal(findLocalFileReference(value,['piano.ogg'],{allowBasename:true}), -1);
  }
});

test('case-sensitive complete paths win over folded and basename matches', () => {
  const references=['sounds/Piano.ogg','sounds/piano.ogg','other/Piano.ogg','Piano.ogg'];
  assert.deepEqual(matchLocalFileReferences('sounds/Piano.ogg',references,{allowBasename:true}),{indices:[0],kind:'exact'});
  assert.equal(findLocalFileReference('Piano.ogg',references,{allowBasename:true}),3);
  assert.equal(findLocalFileReference('/C:/Piano.ogg',['/c:/Piano.ogg','/C:/Piano.ogg']),1);
});

test('a unique folded full path can be reused, without treating distinct folders as aliases', () => {
  assert.deepEqual(matchLocalFileReferences('.\\custom\\piano.OGG',['Custom/Piano.ogg','other/piano.ogg']),{indices:[0],kind:'case'});
  assert.equal(findLocalFileReference('other/Piano.ogg',['Custom/Piano.ogg']),-1);
  assert.equal(findLocalFileReference('C:\\SOUNDS\\piano.ogg',['c:/sounds/Piano.ogg']),0);
});

test('an explicitly selected file may uniquely bind a relocated Linux, Windows or fakepath sample', () => {
  for (const reference of ['/home/user/Sounds/Piano.ogg','C:\\Sounds\\Piano.ogg','C:\\fakepath\\Piano.ogg','./sounds/Piano.ogg']) {
    assert.equal(findLocalFileReference('Piano.ogg',[reference,'other/drum.ogg'],{allowBasename:true}),0);
  }
  assert.equal(findLocalFileReference('C:\\fakepath\\Piano.ogg',['/home/user/Sounds/Piano.ogg'],{allowBasename:true}),0);
  assert.equal(findLocalFileReference('piano.ogg',['/home/user/Sounds/Piano.ogg'],{allowBasename:true}),0);
  assert.equal(findLocalFileReference('new.ogg',['/home/user/Sounds/Piano.ogg'],{allowBasename:true}),-1);
});

test('folded paths, duplicate definitions and leaf-name ambiguity never silently select the first sound', () => {
  for (const [file,references,options] of [
    ['sounds/PIANO.ogg',['sounds/Piano.ogg','sounds/piano.ogg'],{}],
    ['piano.ogg',['/home/a/piano.ogg','/home/b/piano.ogg'],{allowBasename:true}],
    ['Piano.ogg',['/home/a/Piano.ogg','/home/b/piano.ogg'],{allowBasename:true}],
    ['sounds/Piano.ogg',['sounds/Piano.ogg','sounds\\Piano.ogg'],{}],
  ]) assert.throws(()=>findLocalFileReference(file,references,options),/歧义/);
});
