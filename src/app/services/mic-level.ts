import { Injectable, signal } from '@angular/core';

const BAR_COUNT = 5;

// SpeechRecognition owns its own internal mic capture with no way to read
// its audio — so this opens a second, independent getUserMedia stream just
// for visualization. Both share the same OS-level microphone permission the
// user already granted, so this doesn't prompt a second time in practice.
@Injectable({ providedIn: 'root' })
export class MicLevelService {
  readonly levels = signal<number[]>(new Array(BAR_COUNT).fill(0));

  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;

  async start(): Promise<void> {
    if (this.audioContext) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Silent — this is a visual nice-to-have on top of STT, which already
      // surfaces its own mic-access errors through its own path.
      return;
    }

    this.audioContext = new AudioContext();
    // Created inside an effect()'s reaction to speech.listening(), one
    // microtask removed from the click's call stack — Chrome's autoplay
    // policy leaves that "suspended" rather than auto-starting it, so
    // getByteFrequencyData silently returns all zeros without this.
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 64;
    // Deliberately not connected to audioContext.destination — this taps the
    // stream for analysis only, it must never play the mic back out loud.
    source.connect(this.analyser);

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const binsPerBar = Math.max(1, Math.floor(data.length / BAR_COUNT));

    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(data);

      const bars: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = 0; j < binsPerBar; j++) sum += data[i * binsPerBar + j];
        bars.push(sum / binsPerBar / 255);
      }
      this.levels.set(bars);
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.analyser = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.levels.set(new Array(BAR_COUNT).fill(0));
  }
}
