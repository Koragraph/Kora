// steer-text: terminal noise (mouse reports, focus, paste markers, split fragments) is never a "human steer".
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSteerText, isSteerText } from './steer-text';

const steer = (raw: string) => { const t = cleanSteerText(raw); return isSteerText(t) ? t : null; };

test('SGR mouse reports and their ESC-less fragments are not steers', () => {
  assert.equal(steer('\x1b[<35;12;40M'), null);
  assert.equal(steer('\x1b[<0;5;9m\x1b[<0;5;9M'), null);
  assert.equal(steer('[<35;12;40M[<35;13;40M'), null);
  assert.equal(steer('<0;5;9m'), null);
  assert.equal(steer('35;12;40M'), null);
});

test('X10 mouse, focus, paste markers, OSC/DCS replies and arrows are stripped', () => {
  assert.equal(steer('\x1b[M !!'), null);
  assert.equal(steer('\x1b[I\x1b[O'), null);
  assert.equal(steer('\x1bP>|xterm(390)\x1b\\'), null);
  assert.equal(steer('\x1b]11;rgb:0000/0000/0000\x07'), null);
  assert.equal(steer('\x1bOA\x1b[B'), null);
  assert.equal(steer('\x1b[200~fix the tests\x1b[201~'), 'fix the tests');
});

test('real typing survives mixed with mouse noise; backspace and ^U are applied', () => {
  assert.equal(steer('\x1b[<35;12;40Muse the v2 api\r'), 'use the v2 api');
  assert.equal(steer('stopp\x7f now'), 'stop now');
  assert.equal(steer('garbage\x15retry it'), 'retry it');
  assert.equal(steer('ok'), null); // too short to be an instruction worth relaying
});
