// Streaming-style microphone button. Robin's read on the prior single-
// shot version: "持续监听的时间太短了 ，马上就发出去了 我要的是实时的
// 监听 我说什么 就一直会监听 实时流的形式 等我不说话大概5秒后才结束"
// — keep listening as I speak, real-time stream, only commit when I've
// been silent for ~5 seconds.
//
// Behaviour now:
//   • `continuous: true` — recognition stays open across pauses.
//   • A live interim strip floats above the input while you speak so
//     you can see what the recognizer is hearing in real time.
//   • An accumulator stitches every final segment together with the
//     latest interim. The single `onTranscript` fires once per spoken
//     turn with the whole utterance.
//   • A silence timer (default 5s) resets on each onresult event. When
//     it expires we commit that turn, but the mic stays open for the
//     next turn. Clicking the mic again commits early and turns it off.
//
// SpeechRecognition is non-standard; typed `any` to avoid pulling in
// dom-speech-recognition for one component. Returns null on browsers
// without support so the caller renders a no-op button slot.

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Fired once per spoken turn after the user is quiet for `silenceMs`.
   *  Empty transcript (silence-only session) is suppressed. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Milliseconds of silence after the last result before we commit
   *  the current spoken turn. Default 5000ms — Robin's "等我不说话大概5秒后才结束". */
  silenceMs?: number;
  /** Recognizer language code. Defaults to the browser/system locale.
   *  Override to e.g. 'en-US' for English-only sessions. */
  lang?: string;
}

const SpeechRecognitionImpl: any =
  typeof window !== 'undefined'
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export function VoiceButton({ onTranscript, disabled, silenceMs = 5000, lang }: Props) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  // Accumulated final segments — committed with the trailing interim
  // when silence triggers commit. Stored in a ref because the
  // SpeechRecognition event handlers run outside React's render cycle.
  const finalSegmentsRef = useRef<string[]>([]);
  const interimRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!SpeechRecognitionImpl) return null;

  function clearSilenceTimer() {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  function clearRestartTimer() {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }

  function commitTurn() {
    clearSilenceTimer();
    const finals = finalSegmentsRef.current.join(' ').trim();
    const trailing = interimRef.current.trim();
    const full = [finals, trailing].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    finalSegmentsRef.current = [];
    interimRef.current = '';
    setInterim('');
    if (full) onTranscript(full);
  }

  function scheduleSilenceCommit() {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      commitTurn();
    }, silenceMs);
  }

  function startRecognition() {
    if (!listeningRef.current) return;
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = lang || navigator.language || 'en-US';
    // Continuous so the recognizer keeps listening across natural
    // pauses; interimResults so we can show a live strip and reset
    // the silence timer on partial words too.
    recognition.continuous = true;
    recognition.interimResults = true;

    finalSegmentsRef.current = [];
    interimRef.current = '';
    setInterim('');

    recognition.onresult = (event: any) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalSegmentsRef.current.push(transcript);
        } else {
          interimText += transcript;
        }
      }
      interimRef.current = interimText;
      setInterim(interimText);
      // Reset silence timer on EVERY result (interim or final). User
      // saying anything = "still talking".
      scheduleSilenceCommit();
    };

    recognition.onerror = (event: any) => {
      // 'no-speech' is normal when the user clicks but doesn't talk —
      // treated like a silent close (commit empty if anything bufferred,
      // otherwise just stop). 'aborted' is the user clicking stop, also
      // normal. 'audio-capture' / 'not-allowed' need surfacing.
      const code = event?.error;
      if (code && code !== 'no-speech' && code !== 'aborted') {
        import('./Toast.js').then(({ showToast }) => {
          showToast(`Voice error: ${code}`);
        });
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (listeningRef.current) {
        clearRestartTimer();
        restartTimerRef.current = setTimeout(() => {
          startRecognition();
        }, 150);
      } else {
        clearSilenceTimer();
        setInterim('');
        setListening(false);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      if (listeningRef.current) {
        clearRestartTimer();
        restartTimerRef.current = setTimeout(() => {
          startRecognition();
        }, 250);
      } else {
        setListening(false);
      }
    }
  }

  function start() {
    listeningRef.current = true;
    finalSegmentsRef.current = [];
    interimRef.current = '';
    setInterim('');
    clearSilenceTimer();
    clearRestartTimer();
    startRecognition();
  }

  function stop() {
    listeningRef.current = false;
    clearRestartTimer();
    commitTurn();
    const recognition = recognitionRef.current;
    if (recognition) {
      try { recognition.abort(); } catch { /* already stopped */ }
    }
    recognitionRef.current = null;
    setListening(false);
  }

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      clearSilenceTimer();
      clearRestartTimer();
      const recognition = recognitionRef.current;
      if (recognition) {
        try { recognition.abort(); } catch { /* ignore */ }
      }
    };
  }, []);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={listening ? stop : start}
        aria-label={listening ? 'Stop listening' : 'Start listening'}
        title={listening ? 'Stop listening (commit current turn)' : 'Start streaming voice input'}
        className={`text-base leading-none w-9 h-9 flex items-center justify-center rounded-lg transition ${
          listening
            ? 'bg-red-100 text-red-600 animate-pulse'
            : 'bg-surface-softer text-ink-soft hover:bg-accent-tint hover:text-accent'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        🎤
      </button>
      {listening && (
        <div className="absolute left-3 right-3 -top-7 px-3 py-1 bg-accent-tint text-accent-deep text-[11px] italic rounded-full shadow-sm truncate pointer-events-none">
          {interim ? interim : 'Listening… (sends each turn after ~5s of silence)'}
        </div>
      )}
    </>
  );
}
