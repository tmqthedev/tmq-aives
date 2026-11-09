import test from 'node:test';
import assert from 'node:assert/strict';
import {
  micErrorCode, levelFromTimeDomain, missingAudioSupport, openMicStream,
  markDeviceCheckPassed, hasPassedDeviceCheck, getPreferredMicId, setPreferredMicId,
  VOICE_LEVEL_THRESHOLD,
} from '../src/shared/utils/audioDevices.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

test('getUserMedia errors map to codes the device check explains', () => {
  assert.equal(micErrorCode({ name: 'NotAllowedError' }), 'MIC_DENIED');
  assert.equal(micErrorCode({ name: 'NotFoundError' }), 'MIC_NOT_FOUND');
  assert.equal(micErrorCode({ name: 'NotReadableError' }), 'MIC_IN_USE');
  assert.equal(micErrorCode(new Error('boom')), 'MIC_UNKNOWN');
});

test('silence reads as zero and speech crosses the voice threshold', () => {
  assert.equal(levelFromTimeDomain(new Uint8Array(512).fill(128)), 0);
  const speech = Uint8Array.from({ length: 512 }, (_, i) => 128 + Math.round(30 * Math.sin(i / 4)));
  assert.ok(levelFromTimeDomain(speech) >= VOICE_LEVEL_THRESHOLD);
  assert.equal(levelFromTimeDomain(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0))), 100);
});

test('missing browser features are reported before asking for the microphone', () => {
  const ok = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: function MR() {}, AudioContext: function AC() {} };
  assert.equal(missingAudioSupport(ok), null);
  assert.equal(missingAudioSupport({ ...ok, isSecureContext: false }), 'INSECURE_CONTEXT');
  assert.equal(missingAudioSupport({ ...ok, navigator: {} }), 'NO_GET_USER_MEDIA');
  assert.equal(missingAudioSupport({ ...ok, MediaRecorder: undefined }), 'NO_MEDIA_RECORDER');
});

test('the chosen microphone is reused and dropped when it is unplugged', async () => {
  globalThis.localStorage = memoryStorage();
  setPreferredMicId('usb-mic');
  const calls = [];
  const mediaDevices = { async getUserMedia(c) {
    calls.push(c);
    if (c.audio?.deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
    return 'default-stream';
  } };
  assert.equal(await openMicStream(getPreferredMicId(), mediaDevices), 'default-stream');
  assert.deepEqual(calls, [{ audio: { deviceId: { exact: 'usb-mic' } } }, { audio: true }]);
  assert.equal(getPreferredMicId(), null);
  const denied = { async getUserMedia() { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } };
  await assert.rejects(openMicStream('x', denied), { name: 'NotAllowedError' });
});

test('a passed check is remembered per interview in this tab', () => {
  globalThis.sessionStorage = memoryStorage();
  assert.equal(hasPassedDeviceCheck(7), false);
  markDeviceCheckPassed(7);
  assert.equal(hasPassedDeviceCheck(7), true);
  assert.equal(hasPassedDeviceCheck(8), false);
});
