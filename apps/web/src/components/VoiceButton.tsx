import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Called once with the final recognized transcript when the user stops or
   *  the recognizer ends. Caller decides how to merge into the input field. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

// Browser SpeechRecognition is non-standard: typed as `any` to avoid pulling
// in a dom-speech-recognition lib for a single component. Returns null when
// the browser doesn't support it (Firefox, older Safari) — caller renders
// nothing in that case.
const SpeechRecognitionImpl: any =
  typeof window !== 'undefined'
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export function VoiceButton({ onTranscript, disabled }: Props) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<any>(null);

  // Hidden entirely when unsupported — no UI noise, no console error.
  if (!SpeechRecognitionImpl) return null;

  function start() {
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    let finalText = '';

    recognition.onresult = (event: any) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      setInterim(interimText);
    };

    recognition.onerror = (event: any) => {
      // 'no-speech' / 'aborted' are normal user paths (silent click, manual stop) — silent.
      if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        import('./Toast.js').then(({ showToast }) => {
          showToast(`Voice error: ${event.error}`);
        });
      }
    };

    recognition.onend = () => {
      const text = finalText.trim();
      if (text) onTranscript(text);
      setInterim('');
      setListening(false);
      recognitionRef.current = null;
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      // Some browsers throw if start() is called twice in quick succession.
      setListening(false);
    }
  }

  function stop() {
    recognitionRef.current?.stop();
  }

  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={listening ? stop : start}
        aria-label={listening ? 'Stop voice input' : 'Start voice input'}
        title={listening ? 'Stop voice input' : 'Start voice input'}
        className={`leading-none w-10 h-10 sm:w-9 sm:h-9 flex items-center justify-center rounded-lg transition ${
          listening
            ? 'bg-red-100 text-red-600 animate-pulse'
            : 'bg-surface-softer text-ink-soft hover:bg-accent-tint hover:text-accent'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="6" y="2" width="4" height="7" rx="2" />
          <path d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14" />
        </svg>
      </button>
      {listening && interim && (
        <div className="absolute left-3 right-3 -top-7 px-3 py-1 bg-accent-tint text-accent-deep text-[11px] italic rounded-full shadow-sm truncate pointer-events-none">
          {interim}
        </div>
      )}
    </>
  );
}
