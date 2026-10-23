import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTempoTapper,nativeSongStatistics,resetNativeWorkStatistics,WORK_STAT_FIELDS} from '../js/native-dialogs.js';

test('statistics read the five actual NBS metadata counters and native instrument percentages',()=>{
  const song={layers:[{}],notes:[{instrument:0},{instrument:0},{instrument:16}],customInstruments:[{name:'我的音色'}],metadata:{minutesSpent:12.9,leftClicks:10,rightClicks:4,blocksAdded:3,blocksRemoved:1}};
  const result=nativeSongStatistics(song);assert.equal(result.total,3);assert.equal(result.instruments.length,17);assert.deepEqual(result.instruments[0],{id:0,name:'竖琴',count:2,percent:66});assert.deepEqual(result.instruments[16],{id:16,name:'我的音色',count:1,percent:33});assert.equal(result.instruments[1].percent,0);
  assert.deepEqual(result.work,{minutesSpent:12,leftClicks:10,rightClicks:4,blocksAdded:3,blocksRemoved:1});
  assert.deepEqual(WORK_STAT_FIELDS.map(([key])=>key),['minutesSpent','leftClicks','rightClicks','blocksAdded','blocksRemoved']);
});

test('empty or malformed historical counters display safely without mutating imported metadata',()=>{
  const song={notes:[],metadata:{minutesSpent:NaN,leftClicks:-1,rightClicks:Infinity,blocksAdded:2**40}};const result=nativeSongStatistics(song);
  assert.ok(result.instruments.every(instrument=>instrument.percent===0));assert.deepEqual(result.work,{minutesSpent:0,leftClicks:0,rightClicks:0,blocksAdded:0xffffffff,blocksRemoved:0});assert.equal(song.metadata.leftClicks,-1);
});

test('reset stages metadata before one history checkpoint and preserves project provenance and content',()=>{
  const metadata={minutesSpent:8,leftClicks:4,rightClicks:2,blocksAdded:1,blocksRemoved:1,midiFile:'score.mid',browserProjectId:'local-id',other:{retained:true}},song={metadata,notes:[{id:'note'}]};let checkpoints=0;
  resetNativeWorkStatistics(song,()=>{checkpoints++;assert.equal(song.metadata,metadata);assert.equal(song.metadata.minutesSpent,8);});
  assert.equal(checkpoints,1);assert.equal(song.metadata.midiFile,'score.mid');assert.equal(song.metadata.browserProjectId,'local-id');assert.equal(song.notes[0].id,'note');assert.equal(metadata.minutesSpent,8);assert.ok(WORK_STAT_FIELDS.every(([key])=>song.metadata[key]===0));
  const before=song.metadata;assert.throws(()=>resetNativeWorkStatistics(song,()=>{throw Error('history full');}),/history full/);assert.equal(song.metadata,before);
});

test('native tapper requires two presses and applies rounded BPM with a real double-tempo option',()=>{
  const tapper=new NativeTempoTapper();assert.equal(tapper.tempo(),null);assert.equal(tapper.tap(1000),null);assert.equal(tapper.tap(1500),120);assert.equal(tapper.tempo(),8);assert.equal(tapper.tempo(true),16);assert.equal(tapper.tap(2000),120);
  const varied=new NativeTempoTapper();varied.tap(0);varied.tap(500);assert.equal(varied.tap(1100),113);assert.equal(varied.tempo(),113/15);
});

test('long gaps or clock rollback restart measurement; zero intervals and invalid times never produce Infinity',()=>{
  const tapper=new NativeTempoTapper();tapper.tap(0);tapper.tap(500);assert.equal(tapper.tap(3000),null);assert.equal(tapper.tempo(),null);assert.equal(tapper.tap(3500),120);assert.equal(tapper.tap(3500),120);assert.equal(tapper.tap(10),null);assert.throws(()=>tapper.tap(NaN),/有限/);assert.equal(tapper.tempo(),null);
});
