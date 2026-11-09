import { t, useLocale } from '../../i18n/index';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Volume2, CheckCircle2, AlertTriangle, Play, RotateCw } from 'lucide-react';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Feedback } from '../ui/Feedback';
import { LoadingSpinner } from '../ui/Loading';
import { getAudioPrefs, saveAudioPrefs } from '../../shared/utils/interviewAudio';

export default function DeviceCheck({
  isOpen,
  onClose,
  onConfirm,
  isResume = false,
  examTitle = '',
}) {
  useLocale();

  const [prefs, setPrefs] = useState(() => getAudioPrefs());
  const [micGranted, setMicGranted] = useState(false);
  const [micChecking, setMicChecking] = useState(false);
  const [micError, setMicError] = useState(null);

  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const supportsSetSinkId = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  // Live input level (0-100)
  const [micLevel, setMicLevel] = useState(0);
  const [voiceDetected, setVoiceDetected] = useState(false);

  // Speaker testing
  const [playingTone, setPlayingTone] = useState(false);
  const [speakerTested, setSpeakerTested] = useState(false);
  const [speakerConfirmed, setSpeakerConfirmed] = useState(false);

  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const gainNodeRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const accumulatedSpeechMsRef = useRef(0);
  const lastSampleTimeRef = useRef(null);
  const toneAudioRef = useRef(null);

  // Clean up Web Audio and media stream
  const stopAudio = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch {
        /* ignore */
      }
      audioContextRef.current = null;
    }
    gainNodeRef.current = null;
    analyserRef.current = null;
  }, []);

  // Update preferences both in state and localStorage
  const updatePref = useCallback((key, value) => {
    setPrefs((prev) => {
      const updated = { ...prev, [key]: value };
      saveAudioPrefs(updated);
      return updated;
    });
  }, []);

  // Enumerate devices
  const enumerateAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);

      setPrefs((currentPrefs) => {
        let changed = false;
        let newMic = currentPrefs.micDeviceId;
        let newSpeaker = currentPrefs.speakerDeviceId;

        if (inputs.length > 0 && (!newMic || !inputs.some((d) => d.deviceId === newMic))) {
          newMic = inputs[0].deviceId;
          changed = true;
        }
        if (outputs.length > 0 && (!newSpeaker || !outputs.some((d) => d.deviceId === newSpeaker))) {
          newSpeaker = outputs[0].deviceId;
          changed = true;
        }

        if (changed) {
          const updated = { ...currentPrefs, micDeviceId: newMic, speakerDeviceId: newSpeaker };
          saveAudioPrefs(updated);
          return updated;
        }
        return currentPrefs;
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Initialize microphone stream & analyzer
  const initMicrophone = useCallback(async (preferredDeviceId, sensitivityGain) => {
    stopAudio();
    await Promise.resolve();
    setMicChecking(true);
    setMicError(null);

    try {
      const constraints = preferredDeviceId
        ? { audio: { deviceId: { exact: preferredDeviceId } } }
        : { audio: true };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        // Fallback to default audio device if exact ID fails
        if (preferredDeviceId) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      mediaStreamRef.current = stream;
      setMicGranted(true);

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        setMicChecking(false);
        return;
      }

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = sensitivityGain ?? 1.0;
      gainNodeRef.current = gainNode;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      analyserRef.current = analyser;

      source.connect(gainNode);
      gainNode.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      accumulatedSpeechMsRef.current = 0;
      lastSampleTimeRef.current = performance.now();

      const monitorLevel = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i += 1) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalized = Math.min(100, Math.round((avg / 128) * 100));
        setMicLevel(normalized);

        const now = performance.now();
        const delta = Math.min(100, now - (lastSampleTimeRef.current || now));
        lastSampleTimeRef.current = now;

        // Speech-level threshold check (~500ms required)
        if (normalized >= 15) {
          accumulatedSpeechMsRef.current += delta;
          if (accumulatedSpeechMsRef.current >= 500) {
            setVoiceDetected(true);
          }
        }

        animFrameRef.current = requestAnimationFrame(monitorLevel);
      };

      animFrameRef.current = requestAnimationFrame(monitorLevel);
      await enumerateAudioDevices();
    } catch (err) {
      setMicGranted(false);
      setMicError(
        err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
          ? t("Quyền truy cập micro đã bị từ chối. Vui lòng cấp quyền trong cài đặt trình duyệt để tiếp tục.")
          : t("Không thể kết nối với microphone: ") + err.message
      );
    } finally {
      setMicChecking(false);
    }
  }, [stopAudio, enumerateAudioDevices]);

  // Handle device initialization when dialog opens
  useEffect(() => {
    if (!isOpen) {
      stopAudio();
      return undefined;
    }
    const initialPrefs = getAudioPrefs();
    let cancelled = false;
    (async () => {
      await Promise.resolve();
      if (!cancelled) {
        initMicrophone(initialPrefs.micDeviceId, initialPrefs.gain);
      }
    })();
    return () => {
      cancelled = true;
      stopAudio();
    };
  }, [isOpen, initMicrophone, stopAudio]);

  // Live gain adjustment
  const handleGainChange = (newGain) => {
    const val = Number(newGain);
    updatePref('gain', val);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = val;
    }
  };

  // Live volume adjustment
  const handleVolumeChange = (newVolume) => {
    const val = Number(newVolume);
    updatePref('volume', val);
    if (toneAudioRef.current) {
      toneAudioRef.current.volume = val;
    }
  };

  // Switch mic device
  const handleMicChange = (deviceId) => {
    updatePref('micDeviceId', deviceId);
    initMicrophone(deviceId, prefs.gain);
  };

  // Switch speaker device
  const handleSpeakerChange = (deviceId) => {
    updatePref('speakerDeviceId', deviceId);
    if (toneAudioRef.current && typeof toneAudioRef.current.setSinkId === 'function') {
      toneAudioRef.current.setSinkId(deviceId).catch(() => {});
    }
  };

  // Speaker test: play short generated tone (OscillatorNode)
  const playSpeakerTestTone = async () => {
    if (playingTone) return;
    setPlayingTone(true);
    setSpeakerTested(true);

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = prefs.volume ?? 1.0;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.25); // A5

      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);

      const audio = new Audio();
      toneAudioRef.current = audio;
      audio.srcObject = dest.stream;
      audio.volume = prefs.volume ?? 1.0;

      if (prefs.speakerDeviceId && typeof audio.setSinkId === 'function') {
        try {
          await audio.setSinkId(prefs.speakerDeviceId);
        } catch {
          /* ignore */
        }
      }

      await audio.play();
      osc.start();
      osc.stop(ctx.currentTime + 0.6);

      setTimeout(() => {
        setPlayingTone(false);
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
      }, 700);
    } catch {
      setPlayingTone(false);
    }
  };

  const handleStartExam = () => {
    saveAudioPrefs(prefs);
    stopAudio();
    if (typeof onConfirm === 'function') {
      onConfirm(prefs);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        stopAudio();
        onClose();
      }}
      title={isResume ? t("Kiểm tra thiết bị • Tiếp tục thi") : t("Kiểm tra thiết bị trước khi bắt đầu thi")}
    >
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {examTitle && (
          <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            {t("Kỳ thi:")} <strong style={{ color: 'var(--text-main)' }}>{examTitle}</strong>
          </div>
        )}

        {micError && (
          <div>
            <Feedback type="error" message={micError} />
            <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="sm" variant="outline" onClick={() => initMicrophone(prefs.micDeviceId, prefs.gain)}>
                <RotateCw size={14} /> {t("Thử lại quyền micro")}
              </Button>
            </div>
          </div>
        )}

        {/* 1. Microphone Selection & Live Level */}
        <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '600' }}>
              <Mic size={18} style={{ color: micGranted ? '#10b981' : 'var(--text-muted)' }} />
              <span>{t("Microphone (Bắt buộc)")}</span>
            </div>
            {voiceDetected ? (
              <Badge type="success">
                <CheckCircle2 size={12} style={{ marginRight: '4px' }} /> {t("Đã nhận diện giọng nói")}
              </Badge>
            ) : micGranted ? (
              <Badge type="warning">{t("Hãy nói vào micro (~500ms)")}</Badge>
            ) : (
              <Badge type="neutral">{t("Chưa kết nối")}</Badge>
            )}
          </div>

          {audioInputDevices.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <label htmlFor="mic-select" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                {t("Chọn thiết bị thu âm")}
              </label>
              <select
                id="mic-select"
                value={prefs.micDeviceId || ''}
                onChange={(e) => handleMicChange(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  fontSize: '0.875rem',
                }}
              >
                {audioInputDevices.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `${t("Microphone")} ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Live Level Meter */}
          <div style={{ marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
              <span>{t("Cường độ âm thanh đầu vào")}</span>
              <span style={{ fontWeight: '600', color: micLevel >= 15 ? '#10b981' : 'var(--text-muted)' }}>
                {micLevel}%
              </span>
            </div>
            <div style={{ width: '100%', height: '10px', background: 'var(--border, rgba(0,0,0,0.1))', borderRadius: '5px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${micLevel}%`,
                  height: '100%',
                  background: micLevel > 75 ? '#ef4444' : micLevel >= 15 ? '#10b981' : '#6366f1',
                  transition: 'width 0.08s ease',
                }}
              />
            </div>
          </div>

          {/* Sensitivity Slider */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              <span>{t("Độ nhạy micro (Gain)")}</span>
              <span style={{ fontWeight: '600' }}>{Number(prefs.gain).toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="3.0"
              step="0.1"
              value={prefs.gain ?? 1.0}
              onChange={(e) => handleGainChange(e.target.value)}
              style={{ width: '100%', accentColor: 'var(--primary, #4f46e5)' }}
            />
          </div>
        </div>

        {/* 2. Speaker Testing & AI Volume */}
        <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '600' }}>
              <Volume2 size={18} style={{ color: 'var(--primary, #4f46e5)' }} />
              <span>{t("Loa / Tai nghe (Tùy chọn)")}</span>
            </div>
            {speakerConfirmed ? (
              <Badge type="success">
                <CheckCircle2 size={12} style={{ marginRight: '4px' }} /> {t("Đã xác nhận nghe rõ")}
              </Badge>
            ) : (
              <Badge type="neutral">{t("Chưa kiểm tra")}</Badge>
            )}
          </div>

          {supportsSetSinkId && audioOutputDevices.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <label htmlFor="speaker-select" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                {t("Chọn thiết bị phát âm thanh")}
              </label>
              <select
                id="speaker-select"
                value={prefs.speakerDeviceId || ''}
                onChange={(e) => handleSpeakerChange(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  fontSize: '0.875rem',
                }}
              >
                {audioOutputDevices.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `${t("Loa")} ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* AI Volume Slider */}
          <div style={{ marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              <span>{t("Âm lượng AI đọc câu hỏi")}</span>
              <span style={{ fontWeight: '600' }}>{Math.round((prefs.volume ?? 1.0) * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={prefs.volume ?? 1.0}
              onChange={(e) => handleVolumeChange(e.target.value)}
              style={{ width: '100%', accentColor: 'var(--primary, #4f46e5)' }}
            />
          </div>

          {/* Test Speaker Button & Feedback */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button
              size="sm"
              variant="outline"
              onClick={playSpeakerTestTone}
              disabled={playingTone}
              icon={<Volume2 size={15} />}
            >
              {playingTone ? t("Đang phát âm thanh thử...") : t("Phát âm thanh thử loa")}
            </Button>

            {speakerTested && !speakerConfirmed && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t("Bạn có nghe thấy không?")}</span>
                <Button size="sm" variant="secondary" onClick={() => setSpeakerConfirmed(true)}>
                  <CheckCircle2 size={14} /> {t("Nghe rõ")}
                </Button>
              </div>
            )}
          </div>

          {speakerTested && !speakerConfirmed && (
            <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontSize: '0.8rem', color: '#b45309' }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>{t("Nếu bạn không nghe thấy loa, câu hỏi vẫn hiển thị đầy đủ bằng văn bản để bạn làm bài thi bình thường.")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button variant="secondary" onClick={() => { stopAudio(); onClose(); }}>
          {t("Hủy bỏ")}
        </Button>

        <Button
          variant="primary"
          onClick={handleStartExam}
          disabled={!micGranted || !voiceDetected || micChecking}
          icon={isResume ? <RotateCw size={16} /> : <Play size={16} />}
        >
          {micChecking ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <LoadingSpinner size={16} /> {t("Đang kiểm tra...")}
            </span>
          ) : isResume ? (
            t("Tiếp tục bài thi")
          ) : (
            t("Bắt đầu làm bài")
          )}
        </Button>
      </div>
    </Modal>
  );
}
