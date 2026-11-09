import { t, useLocale, enumLabel, errorMessage as localizedErrorMessage } from '../../i18n/index';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Mic,
  Volume2,
  Square,
  CheckCircle,
  AlertCircle,
  Clock,
  RotateCw,
  Home,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Feedback } from '../../components/ui/Feedback';
import Modal from '../../components/Modal';
import TranscriptHistory from '../../components/interview/TranscriptHistory';
import { createInterviewSocket } from '../../services/interviewSocket';
import {
  getAudioPrefs,
  saveAudioPrefs,
  playBrowserQuestion,
  resendAudioAnswer,
} from '../../shared/utils/interviewAudio';
import { getInterviewTranscript } from '../../services/studentExamApi';

export default function StudentVivaSession() {
  useLocale();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const interviewIdParam = searchParams.get('interviewId');

  // Phases: 'INITIALIZING', 'QUESTION_PLAYING', 'THINKING', 'ANSWERING', 'PROCESSING', 'RETRY', 'COMPLETED', 'ERROR'
  const [phase, setPhase] = useState(() => (interviewIdParam ? 'INITIALIZING' : 'ERROR'));
  const [sessionState, setSessionState] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [browserSpeechUnavailable, setBrowserSpeechUnavailable] = useState(false);
  const [speechFallback, setSpeechFallback] = useState(false);
  const [ttsStatus, setTtsStatus] = useState('IDLE'); // 'IDLE', 'PLAYING', 'FINISHED', 'UNAVAILABLE'
  const [hasLastRecording, setHasLastRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState(() => (!interviewIdParam ? t("Missing interviewId parameter.") : null));

  // Timers
  const [thinkCountdown, setThinkCountdown] = useState(0);
  const [answerCountdown, setAnswerCountdown] = useState(0);
  const [sessionRemainingSec, setSessionRemainingSec] = useState(null);

  // Audio preferences & devices
  const [audioPrefs, setAudioPrefs] = useState(() => getAudioPrefs());
  const audioPrefsRef = useRef(audioPrefs);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const supportsSetSinkId = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  // Transcript History
  const [transcriptTurns, setTranscriptTurns] = useState([]);

  // Refs
  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainNodeRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioElementRef = useRef(null);
  const thinkIntervalRef = useRef(null);
  const answerIntervalRef = useRef(null);
  const sessionIntervalRef = useRef(null);
  const playQuestionAudioRef = useRef(null);
  const examLanguageRef = useRef('VI');
  const currentQuestionRef = useRef(null);
  const submittingRef = useRef(false);
  const submitAnswerRef = useRef(null);
  const browserPlaybackRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const lastRecordingRef = useRef(null);
  const startAnswerRecordingRef = useRef(null);

  // Keep audioPrefsRef in sync with state
  const updateAudioPref = useCallback((key, value) => {
    setAudioPrefs((prev) => {
      const updated = { ...prev, [key]: value };
      audioPrefsRef.current = updated;
      saveAudioPrefs(updated);
      return updated;
    });
  }, []);

  // Enumerate devices
  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputDevices(devices.filter((d) => d.kind === 'audioinput'));
      setAudioOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
    } catch {
      /* ignore */
    }
  }, []);

  // Load transcript from REST API
  const loadTranscript = useCallback(async () => {
    if (!interviewIdParam) return;
    try {
      const data = await getInterviewTranscript(Number(interviewIdParam));
      if (data && Array.isArray(data.turns)) {
        setTranscriptTurns(data.turns);
      }
    } catch {
      /* ignore */
    }
  }, [interviewIdParam]);

  // Clean up media resources
  const cleanupMedia = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try { audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
    gainNodeRef.current = null;
    browserPlaybackRef.current?.cancel();
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }
    clearInterval(thinkIntervalRef.current);
    clearInterval(answerIntervalRef.current);
    clearInterval(sessionIntervalRef.current);
  }, []);

  useEffect(() => {
    return () => {
      cleanupMedia();
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [cleanupMedia]);

  // Load transcript on mount
  useEffect(() => {
    let cancelled = false;
    getInterviewTranscript(Number(interviewIdParam))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.turns)) {
          setTranscriptTurns(data.turns);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [interviewIdParam]);

  // Transition from question playing to thinking window
  const handleQuestionPlayed = useCallback((q) => {
    setTtsStatus('FINISHED');
    if (!socketRef.current) return;

    socketRef.current.emit('question:played', {
      interviewId: Number(interviewIdParam),
      turnId: q.turnId,
    }, (res) => {
      if (res && res.view) {
        setSessionState(res.view);
      }
    });

    const thinkSec = q.thinkTimeSec ?? 0;
    if (thinkSec > 0) {
      setPhase('THINKING');
      setThinkCountdown(thinkSec);

      clearInterval(thinkIntervalRef.current);
      thinkIntervalRef.current = setInterval(() => {
        setThinkCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(thinkIntervalRef.current);
            startAnswerRecordingRef.current?.(q);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      startAnswerRecordingRef.current?.(q);
    }
  }, [interviewIdParam]);

  const fallbackSpeech = useCallback((q) => {
    setSpeechFallback(true);
    setTtsStatus('PLAYING');
    browserPlaybackRef.current?.cancel();
    const playback = playBrowserQuestion(
      q.questionText,
      q.language || examLanguageRef.current,
      () => handleQuestionPlayed(q),
      {
        onUnavailable: () => {
          setTtsStatus('UNAVAILABLE');
          setBrowserSpeechUnavailable(true);
        },
      }
    );
    browserPlaybackRef.current = playback;
    if (!playback.supported) {
      setTtsStatus('UNAVAILABLE');
      setBrowserSpeechUnavailable(true);
    }
  }, [handleQuestionPlayed]);

  // Play question audio with saved volume and output device
  const playQuestionAudio = useCallback((q) => {
    submittingRef.current = false;
    recordedChunksRef.current = [];
    lastRecordingRef.current = null;
    setHasLastRecording(false);
    browserPlaybackRef.current?.cancel();
    setBrowserSpeechUnavailable(false);
    setSpeechFallback(false);
    setTtsStatus('PLAYING');
    currentQuestionRef.current = q;
    setCurrentQuestion(q);
    setPhase('QUESTION_PLAYING');

    if (q.questionAudioUrl) {
      const audio = new Audio(q.questionAudioUrl);
      audioElementRef.current = audio;
      audio.volume = audioPrefsRef.current.volume ?? 1.0;

      if (audioPrefsRef.current.speakerDeviceId && typeof audio.setSinkId === 'function') {
        audio.setSinkId(audioPrefsRef.current.speakerDeviceId).catch(() => {});
      }

      audio.onended = () => {
        handleQuestionPlayed(q);
      };

      audio.onerror = () => {
        fallbackSpeech(q);
      };

      audio.play().catch(() => {
        fallbackSpeech(q);
      });
    } else {
      fallbackSpeech(q);
    }
  }, [handleQuestionPlayed, fallbackSpeech]);

  useEffect(() => {
    playQuestionAudioRef.current = playQuestionAudio;
  });

  // Start recording answer with saved micDeviceId and gain
  const startAnswerRecording = async (q) => {
    clearInterval(thinkIntervalRef.current);
    setErrorMessage(null);
    setPhase('ANSWERING');
    recordedChunksRef.current = [];
    lastRecordingRef.current = null;
    setHasLastRecording(false);

    const answerSec = q.answerTimeSec || 120;
    setAnswerCountdown(answerSec);

    if (socketRef.current) {
      socketRef.current.emit('answer:start', {
        interviewId: Number(interviewIdParam),
        turnId: q.turnId,
      });
    }

    try {
      let stream = mediaStreamRef.current;
      if (!stream || !stream.active) {
        const micId = audioPrefsRef.current.micDeviceId;
        const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        mediaStreamRef.current = stream;
      }

      // Apply sensitivity GainNode via Web Audio destination
      let recordStream = stream;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const gainNode = ctx.createGain();
          gainNode.gain.value = audioPrefsRef.current.gain ?? 1.0;
          gainNodeRef.current = gainNode;
          const dest = ctx.createMediaStreamDestination();
          source.connect(gainNode);
          gainNode.connect(dest);
          if (dest.stream && dest.stream.getAudioTracks().length > 0) {
            recordStream = dest.stream;
          }
        }
      } catch {
        /* fallback to raw stream */
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(recordStream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && socketRef.current) {
          recordedChunksRef.current.push(e.data);
          socketRef.current.emit('audio:chunk', {
            interviewId: Number(interviewIdParam),
            turnId: q.turnId,
            chunk: e.data,
          });
        }
      };

      recorder.start(1000);
    } catch (err) {
      setErrorMessage(t("Could not initialize audio recorder: ") + err.message);
    }

    // Answer countdown timer
    clearInterval(answerIntervalRef.current);
    answerIntervalRef.current = setInterval(() => {
      setAnswerCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(answerIntervalRef.current);
          submitAnswerRef.current?.(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Submit answer
  const submitRecordedAnswer = (timedOut = false) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    clearInterval(answerIntervalRef.current);
    setPhase('PROCESSING');

    // Add placeholder turn into transcript list awaiting transcription
    const q = currentQuestionRef.current;
    if (q) {
      setTranscriptTurns((prev) => {
        const existingIdx = prev.findIndex((t) => t.turnId === q.turnId);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = { ...updated[existingIdx], answeredAt: new Date().toISOString() };
          return updated;
        }
        return [
          ...prev,
          {
            turnId: q.turnId,
            sequenceNo: q.questionNo,
            turnType: q.turnType || 'MAIN',
            questionText: q.questionText,
            transcript: null,
            answeredAt: new Date().toISOString(),
            sttDisputed: false,
            sttDisputeNote: null,
          },
        ];
      });
    }

    const send = () => {
      if (!socketRef.current || !q) {
        submittingRef.current = false;
        return;
      }
      lastRecordingRef.current = {
        interviewId: Number(interviewIdParam),
        turnId: q.turnId,
        chunks: [...recordedChunksRef.current],
        contentType: mediaRecorderRef.current?.mimeType || 'audio/webm',
        timedOut: !!timedOut,
      };
      setHasLastRecording(recordedChunksRef.current.length > 0);

      socketRef.current.emit(
        'answer:end',
        {
          interviewId: Number(interviewIdParam),
          turnId: q.turnId,
          contentType: mediaRecorderRef.current?.mimeType || 'audio/webm',
          timedOut: !!timedOut,
        },
        (res) => {
          submittingRef.current = false;
          if (!res || !res.ok) {
            setErrorMessage(res?.code ? localizedErrorMessage(res) : res?.error || t("Failed to submit answer."));
          }
        }
      );
    };

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.addEventListener('stop', send, { once: true });
      recorder.stop();
    } else {
      send();
    }
  };

  useEffect(() => {
    submitAnswerRef.current = submitRecordedAnswer;
    startAnswerRecordingRef.current = startAnswerRecording;
  });

  // Skip thinking countdown
  const handleSkipThinking = () => {
    clearInterval(thinkIntervalRef.current);
    if (currentQuestion) {
      startAnswerRecording(currentQuestion);
    }
  };

  // Connect socket and register events
  useEffect(() => {
    if (!interviewIdParam) return;

    const socket = createInterviewSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      loadTranscript();

      socket.emit('interview:join', { interviewId: Number(interviewIdParam) }, (res) => {
        if (!res || !res.ok) {
          setErrorMessage(res?.code ? localizedErrorMessage(res) : res?.error || t("Failed to join interview room."));
          setPhase('ERROR');
          return;
        }
        examLanguageRef.current = res.state.language || 'VI';
        setSessionState(res.state);

        if (res.state.status === 'COMPLETED' || res.state.endedAt) {
          setPhase('COMPLETED');
        } else if (res.state.currentTurn?.status === 'ANSWERING') {
          const q = {
            turnId: res.state.currentTurn.turnId,
            questionText: res.state.currentTurn.questionText,
            questionAudioUrl: res.state.currentTurn.audioKey
              ? `/api/tts/${res.state.currentTurn.audioKey.split('/').pop()}`
              : null,
            thinkTimeSec: res.state.thinkTimeSec ?? 0,
            answerTimeSec: res.state.answerTimeLimitSec ?? 120,
            questionNo: res.state.questionNumber ?? 1,
            followUpNo: res.state.followUpNumber ?? 0,
            totalQuestions: res.state.totalQuestions ?? 0,
            maxFollowUps: res.state.maxFollowUps ?? 0,
            turnType: res.state.currentTurn.turnType,
          };
          currentQuestionRef.current = q;
          setCurrentQuestion(q);
          const remSec = Math.max(1, Math.floor((res.state.currentTurn.remainingAnswerMs || 1000) / 1000));
          setAnswerCountdown(remSec);
          setPhase('RETRY');
        } else if (res.state.currentTurn?.status === 'ASKED') {
          const isFirstQuestion =
            !res.state.currentTurn.playedAt &&
            (res.state.questionNumber ?? 1) === 1 &&
            (res.state.followUpNumber ?? 0) === 0;

          const q = {
            turnId: res.state.currentTurn.turnId,
            questionText: res.state.currentTurn.questionText,
            questionAudioUrl: res.state.currentTurn.audioKey
              ? `/api/tts/${res.state.currentTurn.audioKey.split('/').pop()}`
              : null,
            thinkTimeSec: res.state.thinkTimeSec ?? 0,
            answerTimeSec: res.state.answerTimeLimitSec ?? 120,
            questionNo: res.state.questionNumber ?? 1,
            followUpNo: res.state.followUpNumber ?? 0,
            totalQuestions: res.state.totalQuestions ?? 0,
            maxFollowUps: res.state.maxFollowUps ?? 0,
            turnType: res.state.currentTurn.turnType,
          };
          currentQuestionRef.current = q;
          setCurrentQuestion(q);

          if (isFirstQuestion) {
            // Already checked device before entering; begin immediately
            socket.emit('interview:ready', { interviewId: Number(interviewIdParam) });
          } else {
            playQuestionAudioRef.current?.(q);
          }
        }
      });
    });

    socket.on('connect_error', (err) => {
      setErrorMessage(localizedErrorMessage({ code: err.code || err.message }));
      setPhase('ERROR');
    });

    socket.on('interview:state', (state) => {
      examLanguageRef.current = state.language || examLanguageRef.current;
      setSessionState(state);
    });

    socket.on('question:new', (q) => {
      currentQuestionRef.current = q;
      setCurrentQuestion(q);
      playQuestionAudioRef.current?.(q);
    });

    // Realtime transcript event
    socket.on('turn:transcribed', (data) => {
      if (!data || !data.turnId) return;
      setTranscriptTurns((prev) => {
        const idx = prev.findIndex((t) => t.turnId === data.turnId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], transcript: data.transcript };
          return updated;
        }
        return [
          ...prev,
          {
            turnId: data.turnId,
            sequenceNo: data.sequenceNo,
            turnType: 'MAIN',
            questionText: currentQuestionRef.current?.questionText || '',
            transcript: data.transcript,
            answeredAt: new Date().toISOString(),
            sttDisputed: false,
            sttDisputeNote: null,
          },
        ];
      });
    });

    socket.on('turn:retry', (data) => {
      submittingRef.current = false;
      setPhase('RETRY');
      setErrorMessage(data?.code ? localizedErrorMessage(data) : data?.message || t("Audio rỗng hoặc lỗi nhận diện. Bạn được nói lại 1 lần."));
      if (data?.remainingAnswerMs) {
        setAnswerCountdown(Math.max(1, Math.floor(data.remainingAnswerMs / 1000)));
      }
    });

    socket.on('turn:processing', () => {
      setPhase('PROCESSING');
    });

    socket.on('interview:completed', () => {
      cleanupMedia();
      setPhase('COMPLETED');
    });

    socket.on('turn:error', (err) => {
      submittingRef.current = false;
      setPhase('RETRY');
      setErrorMessage(err.code ? localizedErrorMessage(err) : err.message || t("Turn processing error."));
    });

    socket.connect();
  }, [interviewIdParam, cleanupMedia, loadTranscript]);

  // Session countdown timer
  useEffect(() => {
    if (!sessionState || !sessionState.deadlineAt) return;

    const tick = () => {
      const remainingMs = Math.max(0, new Date(sessionState.deadlineAt).getTime() - Date.now());
      setSessionRemainingSec(Math.floor(remainingMs / 1000));
    };

    tick();
    sessionIntervalRef.current = setInterval(tick, 1000);
    return () => clearInterval(sessionIntervalRef.current);
  }, [sessionState]);

  // Handle sensitivity gain adjustment from audio settings
  const handleGainChange = (newGain) => {
    const val = Number(newGain);
    updateAudioPref('gain', val);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = val;
    }
  };

  // Handle AI playback volume adjustment from audio settings
  const handleVolumeChange = (newVolume) => {
    const val = Number(newVolume);
    updateAudioPref('volume', val);
    if (audioElementRef.current) {
      audioElementRef.current.volume = val;
    }
  };

  // Handle mic change while not recording
  const handleMicChange = async (newDeviceId) => {
    updateAudioPref('micDeviceId', newDeviceId);
    if (phase !== 'ANSWERING') {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: newDeviceId ? { deviceId: { exact: newDeviceId } } : true,
        });
        mediaStreamRef.current = stream;
      } catch {
        /* ignore */
      }
    }
  };

  // Handle speaker change
  const handleSpeakerChange = (newDeviceId) => {
    updateAudioPref('speakerDeviceId', newDeviceId);
    if (audioElementRef.current && typeof audioElementRef.current.setSinkId === 'function') {
      audioElementRef.current.setSinkId(newDeviceId).catch(() => {});
    }
  };

  const formatTimer = (secs) => {
    if (secs == null || isNaN(secs)) return '00:00';
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${enumLabel(s)}`;
  };

  // Render TTS status chip
  const renderTtsChip = () => {
    if (ttsStatus === 'UNAVAILABLE' || browserSpeechUnavailable) {
      return (
        <Badge type="danger">
          <AlertCircle size={12} style={{ marginRight: '4px' }} />
          {t("Không phát được âm thanh — hãy đọc câu hỏi")}
        </Badge>
      );
    }
    if (phase === 'QUESTION_PLAYING') {
      if (speechFallback) {
        return (
          <Badge type="warning">
            <Volume2 size={12} style={{ marginRight: '4px' }} />
            {t("Dùng giọng trình duyệt")}
          </Badge>
        );
      }
      return (
        <Badge type="info">
          <Volume2 size={12} style={{ marginRight: '4px' }} className="animate-pulse" />
          {t("Đang đọc câu hỏi")}
        </Badge>
      );
    }
    if (ttsStatus === 'FINISHED' || phase === 'THINKING' || phase === 'ANSWERING' || phase === 'PROCESSING') {
      return (
        <Badge type="success">
          <CheckCircle size={12} style={{ marginRight: '4px' }} />
          {t("Đọc xong")}
        </Badge>
      );
    }
    return null;
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto', paddingBottom: '3rem' }}>
      {/* Top Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-subtle, rgba(0,0,0,0.03))', padding: '0.75rem 1.25rem', borderRadius: 'var(--radius-lg, 12px)', marginBottom: '1.5rem', border: '1px solid var(--border)', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--primary, #4f46e5)' }}>
            {t("AI Viva Room")}
          </span>
          {sessionState && (
            <Badge type="neutral">
              {t("Question")} {(sessionState.questionNumber ?? 1)}/{sessionState.totalQuestions || 3}
              {sessionState.followUpNumber > 0 && t(" • Follow-up {v0}", { v0: sessionState.followUpNumber })}
            </Badge>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {sessionRemainingSec != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '600', color: sessionRemainingSec < 300 ? '#ef4444' : 'var(--text)' }}>
              <Clock size={16} />
              <span>{t("Session Remaining:")} {formatTimer(sessionRemainingSec)}</span>
            </div>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              enumerateDevices();
              setShowAudioSettings(true);
            }}
            icon={<Sliders size={15} />}
          >
            {t("Cài đặt âm thanh")}
          </Button>
        </div>
      </div>

      {errorMessage && (
        <div style={{ marginBottom: '1.5rem' }}>
          <Feedback type="error" message={errorMessage} onClose={() => setErrorMessage(null)} />
        </div>
      )}

      {speechFallback && (
        <div style={{ marginBottom: '1rem' }}>
          <Feedback type="info" message={t("Voice service unavailable. Using browser speech; the question remains visible.")} />
        </div>
      )}

      {browserSpeechUnavailable && phase === 'QUESTION_PLAYING' && (
        <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
          <Button onClick={() => {
            setBrowserSpeechUnavailable(false);
            handleQuestionPlayed(currentQuestionRef.current);
          }}>
            {t('I have read the question. Continue')}
          </Button>
        </div>
      )}

      {/* Main Examination Question Area */}
      <AnimatePresence mode="wait">
        {phase === 'INITIALIZING' && (
          <motion.div key="init" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Card>
              <CardBody style={{ textAlign: 'center', padding: '5rem 2rem' }}>
                <LoadingSpinner size={42} text={t("Connecting to viva interview session...")} />
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'QUESTION_PLAYING' && currentQuestion && (
          <motion.div key="playing" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <Card style={{ borderLeft: '4px solid #6366f1' }}>
              <CardBody style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {currentQuestion.turnType === 'FOLLOW_UP' ? t("AI Follow-up Question") : t("Main Question")}
                  </span>
                  {renderTtsChip()}
                </div>

                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: '#e0e7ff', color: '#4f46e5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
                  <Volume2 size={32} className="animate-pulse" />
                </div>

                <h3 style={{ fontSize: '1.4rem', fontWeight: '600', lineHeight: 1.5, maxWidth: '650px', margin: '0 auto 1.5rem auto' }}>
                  "{currentQuestion.questionText}"
                </h3>

                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  {t("AI interviewer is speaking... Listen carefully to the question.")}
                </p>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'THINKING' && currentQuestion && (
          <motion.div key="thinking" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <Card style={{ borderLeft: '4px solid #f59e0b' }}>
              <CardBody style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {currentQuestion.turnType === 'FOLLOW_UP' ? t("AI Follow-up Question") : t("Main Question")}
                  </span>
                  {renderTtsChip()}
                </div>

                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', color: '#d97706', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
                  <Sparkles size={32} />
                </div>

                <h3 style={{ fontSize: '1.4rem', fontWeight: '600', lineHeight: 1.5, maxWidth: '650px', margin: '0 auto 1.5rem auto' }}>
                  "{currentQuestion.questionText}"
                </h3>

                <div style={{ fontSize: '2.2rem', fontWeight: '800', color: '#d97706', marginBottom: '1rem' }}>
                  {thinkCountdown}s
                </div>

                <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', marginBottom: '1.5rem' }}>
                  {t("Preparation time. Your microphone will automatically activate when countdown expires.")}
                </p>

                <Button variant="primary" onClick={handleSkipThinking}>
                  <Mic size={18} /> {t("Answer Immediately")}
                </Button>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'ANSWERING' && currentQuestion && (
          <motion.div key="answering" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <Card style={{ borderLeft: '4px solid #ef4444' }}>
              <CardBody style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                    <span style={{ color: '#ef4444', fontWeight: '700', fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                      {t("RECORDING LIVE ANSWER")}
                    </span>
                  </div>
                  {renderTtsChip()}
                </div>

                <h3 style={{ fontSize: '1.4rem', fontWeight: '600', lineHeight: 1.5, maxWidth: '650px', margin: '0 auto 1.5rem auto' }}>
                  "{currentQuestion.questionText}"
                </h3>

                <div style={{ fontSize: '2.5rem', fontWeight: '800', color: answerCountdown < 30 ? '#ef4444' : 'var(--text)', marginBottom: '1.5rem' }}>
                  {formatTimer(answerCountdown)}
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
                  <Button variant="danger" onClick={() => submitRecordedAnswer(false)}>
                    <Square size={18} /> {t("Submit Answer")}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'PROCESSING' && (
          <motion.div key="proc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Card style={{ borderLeft: '4px solid #6366f1' }}>
              <CardBody style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
                {currentQuestion && (
                  <div style={{ marginBottom: '2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        {currentQuestion.turnType === 'FOLLOW_UP' ? t("AI Follow-up Question") : t("Main Question")}
                      </span>
                      {renderTtsChip()}
                    </div>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: '600', lineHeight: 1.5, maxWidth: '650px', margin: '0 auto' }}>
                      "{currentQuestion.questionText}"
                    </h3>
                  </div>
                )}

                <LoadingSpinner size={42} text={t("AI is evaluating your response...")} />
                <p style={{ color: 'var(--text-muted)', marginTop: '1rem', fontSize: '0.9rem' }}>
                  {t("Please do not reload or close your browser window.")}
                </p>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'RETRY' && currentQuestion && (
          <motion.div key="retry" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Card style={{ borderLeft: '4px solid #f59e0b' }}>
              <CardBody style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                  <Badge type="warning">{t("Nói lại câu trả lời")}</Badge>
                  {renderTtsChip()}
                </div>

                <h3 style={{ fontSize: '1.3rem', fontWeight: '600', lineHeight: 1.5, maxWidth: '650px', margin: '0 auto 1.5rem auto' }}>
                  "{currentQuestion.questionText}"
                </h3>

                <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  {hasLastRecording && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (submittingRef.current || !socketRef.current || !lastRecordingRef.current) return;
                        submittingRef.current = true;
                        setErrorMessage(null);
                        setPhase('PROCESSING');
                        resendAudioAnswer(socketRef.current, lastRecordingRef.current, (res) => {
                          submittingRef.current = false;
                          if (!res?.ok) setErrorMessage(localizedErrorMessage(res || {}));
                        });
                      }}
                    >
                      {t('Send recording again')}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={() => {
                      const remaining = Math.floor((new Date(sessionState?.deadlineAt).getTime() - Date.now()) / 1000);
                      if (remaining <= 0) {
                        setPhase('COMPLETED');
                        return;
                      }
                      const q = currentQuestionRef.current;
                      if (q) startAnswerRecording({ ...q, answerTimeSec: Math.min(q.answerTimeSec || 120, remaining) });
                    }}
                  >
                    {t("Record answer again")}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'COMPLETED' && (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
            <Card style={{ borderLeft: '4px solid #10b981' }}>
              <CardBody style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#d1fae5', color: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
                  <CheckCircle size={44} />
                </div>

                <h2 style={{ fontSize: '1.75rem', fontWeight: '700', marginBottom: '0.75rem' }}>
                  {t("Examination Completed!")}
                </h2>

                <p style={{ color: 'var(--text-muted)', maxWidth: '520px', margin: '0 auto 2rem auto', fontSize: '1.05rem', lineHeight: 1.6 }}>
                  {t("Your oral responses and transcripts have been successfully recorded. The AI evaluation suggestions have been queued for lecturer review and grading.")}
                </p>

                <Button variant="primary" onClick={() => navigate('/student')}>
                  <Home size={18} /> {t("Return to Dashboard")}
                </Button>
              </CardBody>
            </Card>
          </motion.div>
        )}

        {phase === 'ERROR' && (
          <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Card style={{ borderLeft: '4px solid #ef4444' }}>
              <CardBody style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
                  <AlertCircle size={36} />
                </div>

                <h3 style={{ fontSize: '1.3rem', fontWeight: '700', marginBottom: '0.5rem' }}>
                  {t("Examination Encountered an Error")}
                </h3>

                <p style={{ color: 'var(--text-muted)', maxWidth: '480px', margin: '0 auto 2rem auto' }}>
                  {errorMessage || t("An unexpected error occurred while communicating with the interview server.")}
                </p>

                <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
                  <Button variant="primary" onClick={() => window.location.reload()}>
                    <RotateCw size={18} /> {t("Retry / Reconnect")}
                  </Button>
                  <Button variant="outline" onClick={() => navigate('/student')}>
                    <Home size={18} /> {t("Dashboard")}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent Read-only Transcript History Panel */}
      {interviewIdParam && phase !== 'INITIALIZING' && phase !== 'ERROR' && (
        <TranscriptHistory
          interviewId={Number(interviewIdParam)}
          turns={transcriptTurns}
          onTurnsUpdate={setTranscriptTurns}
          currentTurnId={currentQuestion?.turnId}
          isRecording={phase === 'ANSWERING'}
          isFinalized={sessionState?.status === 'COMPLETED' || phase === 'COMPLETED'}
        />
      )}

      {/* Audio Settings Modal in Examination Room */}
      <Modal
        isOpen={showAudioSettings}
        onClose={() => setShowAudioSettings(false)}
        title={t("Cài đặt âm thanh phòng thi")}
      >
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* AI Playback Volume */}
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: '600', fontSize: '0.875rem' }}>{t("Âm lượng AI đọc câu hỏi")}</span>
              <span style={{ fontWeight: '700', color: 'var(--primary, #4f46e5)' }}>
                {Math.round((audioPrefs.volume ?? 1.0) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={audioPrefs.volume ?? 1.0}
              onChange={(e) => handleVolumeChange(e.target.value)}
              style={{ width: '100%', accentColor: 'var(--primary, #4f46e5)' }}
            />
          </div>

          {/* Input Sensitivity (Gain) */}
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: '600', fontSize: '0.875rem' }}>{t("Độ nhạy micro (Gain)")}</span>
              <span style={{ fontWeight: '700', color: 'var(--primary, #4f46e5)' }}>
                {Number(audioPrefs.gain ?? 1.0).toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              min="0.5"
              max="3.0"
              step="0.1"
              value={audioPrefs.gain ?? 1.0}
              onChange={(e) => handleGainChange(e.target.value)}
              style={{ width: '100%', accentColor: 'var(--primary, #4f46e5)' }}
            />
          </div>

          {/* Microphone Device Selector */}
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
            <label htmlFor="modal-mic-select" style={{ display: 'block', fontWeight: '600', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
              {t("Microphone thu âm")}
            </label>
            <select
              id="modal-mic-select"
              disabled={phase === 'ANSWERING'}
              value={audioPrefs.micDeviceId || ''}
              onChange={(e) => handleMicChange(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: phase === 'ANSWERING' ? 'var(--bg-subtle, #f1f5f9)' : 'var(--surface)',
                cursor: phase === 'ANSWERING' ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
              }}
            >
              {audioInputDevices.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `${t("Microphone")} ${idx + 1}`}
                </option>
              ))}
            </select>
            {phase === 'ANSWERING' && (
              <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: '#ef4444' }}>
                {t("Không thể đổi microphone khi đang ghi âm câu trả lời.")}
              </p>
            )}
          </div>

          {/* Speaker Device Selector */}
          {supportsSetSinkId && audioOutputDevices.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
              <label htmlFor="modal-speaker-select" style={{ display: 'block', fontWeight: '600', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                {t("Loa / Thiết bị phát")}
              </label>
              <select
                id="modal-speaker-select"
                value={audioPrefs.speakerDeviceId || ''}
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
        </div>

        <div className="modal-footer">
          <Button variant="primary" onClick={() => setShowAudioSettings(false)}>
            {t("Đóng")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
