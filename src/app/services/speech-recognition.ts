import { Injectable, signal } from '@angular/core';

type SpeechRecognitionErrorCode =
  | 'no-speech'
  | 'audio-capture'
  | 'not-allowed'
  | 'network'
  | 'aborted'
  | 'service-not-allowed'
  | 'bad-grammar'
  | 'language-not-supported';

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResultEntry {
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResultEntry;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: SpeechRecognitionErrorCode;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export type VoiceInputErrorReason = 'no-speech' | 'not-allowed' | 'network' | 'unknown';

// How long to wait after the last speech activity (interim or final) before
// treating the pause as "done talking" and stopping on the user's behalf.
// continuous:true never ends on its own, so without this the mic would stay
// open forever until the user manually stops it.
const SILENCE_TIMEOUT_MS = 3500;

@Injectable({ providedIn: 'root' })
export class SpeechRecognitionService {
  private readonly ctor: SpeechRecognitionConstructor | null =
    typeof window === 'undefined' ? null : (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null);

  readonly supported = this.ctor !== null;

  readonly listening = signal(false);

  private active: SpeechRecognition | null = null;

  start(lang: string, onResult: (transcript: string) => void, onError: (reason: VoiceInputErrorReason) => void): void {
    if (!this.ctor || this.listening()) return;

    const recognition = new this.ctor();
    recognition.lang = lang;
    // continuous + interimResults so a whole multi-clause phrase keeps being
    // captured across natural pauses instead of stopping at the first one;
    // segments arrive incrementally and only the "final" ones are kept.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalTranscript = '';
    let errorReported = false;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;

    const resetSilenceTimer = () => {
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => recognition.stop(), SILENCE_TIMEOUT_MS);
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results.item(i);
        if (!result.isFinal) continue;

        const chunk = result.item(0).transcript.trim();
        if (chunk.length === 0) continue;

        finalTranscript = finalTranscript ? `${finalTranscript} ${chunk}` : chunk;
        onResult(finalTranscript);
      }
      resetSilenceTimer();
    };

    recognition.onerror = (event) => {
      // A trailing "no-speech" once we already captured something is just
      // the tail end of the session catching up with our own silence
      // timeout — not a real failure worth interrupting the user about.
      if (event.error === 'no-speech' && finalTranscript.length > 0) return;

      errorReported = true;
      onError(this.mapError(event.error));
    };

    recognition.onend = () => {
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      this.listening.set(false);
      this.active = null;
      if (!errorReported && finalTranscript.length === 0) onError('no-speech');
    };

    this.active = recognition;
    this.listening.set(true);
    resetSilenceTimer();
    recognition.start();
  }

  stop(): void {
    this.active?.stop();
  }

  private mapError(error: SpeechRecognitionErrorCode): VoiceInputErrorReason {
    switch (error) {
      case 'no-speech':
        return 'no-speech';
      case 'not-allowed':
      case 'service-not-allowed':
        return 'not-allowed';
      case 'network':
        return 'network';
      default:
        return 'unknown';
    }
  }
}
