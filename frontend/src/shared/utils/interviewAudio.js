export function examSpeechLocale(language) {
  return String(language || 'VI').toUpperCase().startsWith('EN') ? 'en-US' : 'vi-VN';
}

export const AUDIO_PREFS_KEY = 'aives.audioPrefs';

export function getAudioPrefs() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIO_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : '',
        speakerDeviceId: typeof parsed.speakerDeviceId === 'string' ? parsed.speakerDeviceId : '',
        gain: typeof parsed.gain === 'number' && parsed.gain >= 0.5 && parsed.gain <= 3.0 ? parsed.gain : 1.0,
        volume: typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1.0 ? parsed.volume : 1.0,
      };
    }
  } catch {
    // localStorage may be disabled or corrupt
  }
  return {
    micDeviceId: '',
    speakerDeviceId: '',
    gain: 1.0,
    volume: 1.0,
  };
}

export function saveAudioPrefs(prefs) {
  try {
    const current = getAudioPrefs();
    const merged = { ...current, ...prefs };
    globalThis.localStorage?.setItem(AUDIO_PREFS_KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return prefs;
  }
}

export function resendAudioAnswer(socket, { interviewId, turnId, chunks, contentType, timedOut }, callback) {
  socket.emit('answer:start', { interviewId, turnId });
  for (const chunk of chunks) socket.emit('audio:chunk', { interviewId, turnId, chunk });
  socket.emit('answer:end', { interviewId, turnId, contentType, timedOut }, callback);
}

export function playBrowserQuestion(text, language, onDone, {
  speech = globalThis.window?.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  onUnavailable = () => {},
} = {}) {
  if (!speech || !Utterance || !text) return { supported: false, cancel() {} };
  let finished = false;
  const done = () => { if (!finished) { finished = true; onDone(); } };
  try {
    speech.cancel();
    const utterance = new Utterance(text);
    utterance.lang = examSpeechLocale(language);
    utterance.onend = done;
    utterance.onerror = () => { if (!finished) { finished = true; onUnavailable(); } };
    speech.speak(utterance);
    return { supported: true, cancel() { finished = true; speech.cancel(); } };
  } catch { return { supported: false, cancel() { finished = true; } }; }
}
