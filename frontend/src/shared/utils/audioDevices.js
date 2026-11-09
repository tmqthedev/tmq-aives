// Audio device helpers shared by the pre-exam device check and the exam room.
// Pure functions are exported for the node:test suite; nothing here touches
// React.

const MIC_KEY = 'aives.micDeviceId';
const CHECK_KEY_PREFIX = 'aives.deviceCheck.';

function storage(kind) {
  try { return globalThis[kind] || null; } catch { return null; }
}

export function getPreferredMicId() {
  try { return storage('localStorage')?.getItem(MIC_KEY) || null; } catch { return null; }
}

export function setPreferredMicId(deviceId) {
  try {
    const store = storage('localStorage');
    if (!store) return;
    if (deviceId) store.setItem(MIC_KEY, deviceId);
    else store.removeItem(MIC_KEY);
  } catch { /* storage may be disabled */ }
}

// Remembered per browser tab, so the exam room can skip its own inline check
// after the student passed the modal on the dashboard.
export function markDeviceCheckPassed(interviewId) {
  try { storage('sessionStorage')?.setItem(CHECK_KEY_PREFIX + interviewId, '1'); } catch { /* ignore */ }
}

export function hasPassedDeviceCheck(interviewId) {
  try { return storage('sessionStorage')?.getItem(CHECK_KEY_PREFIX + interviewId) === '1'; } catch { return false; }
}

export function audioConstraints(deviceId) {
  return deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
}

// Opens the preferred microphone, falling back to the default one when the
// remembered device was unplugged.
export async function openMicStream(deviceId = getPreferredMicId(), mediaDevices = globalThis.navigator?.mediaDevices) {
  if (!deviceId) return mediaDevices.getUserMedia({ audio: true });
  try {
    return await mediaDevices.getUserMedia(audioConstraints(deviceId));
  } catch (err) {
    if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
    setPreferredMicId(null);
    return mediaDevices.getUserMedia({ audio: true });
  }
}

// What the browser lacks for the exam, or null when everything is there.
export function missingAudioSupport(env = globalThis) {
  if (env.isSecureContext === false) return 'INSECURE_CONTEXT';
  if (!env.navigator?.mediaDevices?.getUserMedia) return 'NO_GET_USER_MEDIA';
  if (typeof env.MediaRecorder !== 'function') return 'NO_MEDIA_RECORDER';
  if (!(env.AudioContext || env.webkitAudioContext)) return 'NO_AUDIO_CONTEXT';
  return null;
}

// Maps a getUserMedia DOMException to a stable code the UI translates.
export function micErrorCode(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'MIC_DENIED';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'MIC_NOT_FOUND';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'MIC_IN_USE';
    default:
      return 'MIC_UNKNOWN';
  }
}

// RMS of a time-domain byte buffer (128 = silence), scaled to 0..100.
export function levelFromTimeDomain(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  // Speech at a normal distance sits around 0.05-0.2 RMS; scale so it reads mid-bar.
  return Math.min(100, Math.round(rms * 400));
}

// Level above which a frame counts as speech, and how much speech in total
// (ms) proves the microphone picks the student up.
export const VOICE_LEVEL_THRESHOLD = 12;
export const VOICE_REQUIRED_MS = 600;
