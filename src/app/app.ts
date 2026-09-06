import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import { CartProduct, SilpoAgentService } from './services/silpo-agent';
import { SpeechRecognitionService, VoiceInputErrorReason } from './services/speech-recognition';

@Component({
  selector: 'app-root',
  imports: [ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly fb = inject(FormBuilder);
  protected readonly agent = inject(SilpoAgentService);
  protected readonly speech = inject(SpeechRecognitionService);

  protected readonly voiceError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    address: ['', Validators.required],
    request: ['', Validators.required],
  });

  // form.valid is a plain getter, not a signal — route it through
  // statusChanges so canRun stays in sync with both form edits and
  // agent.running() instead of caching a stale value.
  private readonly formStatus = toSignal(this.form.statusChanges.pipe(startWith(this.form.status)), {
    initialValue: this.form.status,
  });

  protected readonly canRun = computed(() => this.formStatus() === 'VALID' && !this.agent.running());

  protected readonly cartItems = computed<CartProduct[]>(
    () => this.agent.result()?.cart.shipments.flatMap((s) => s.products) ?? [],
  );

  protected run(): void {
    if (!this.canRun()) return;
    const { address, request } = this.form.getRawValue();
    void this.agent.run(address, request);
  }

  protected toggleVoiceInput(): void {
    if (!this.speech.supported) {
      this.voiceError.set(
        'Голосове введення не підтримується у цьому браузері. Спробуйте Chrome або Edge, або введіть текст вручну.',
      );
      return;
    }

    if (this.speech.listening()) {
      this.speech.stop();
      return;
    }

    this.voiceError.set(null);
    this.speech.start(
      'uk-UA',
      (transcript) => {
        this.voiceError.set(null);
        this.form.controls.request.setValue(transcript);
      },
      (reason) => this.voiceError.set(this.voiceErrorMessage(reason)),
    );
  }

  private voiceErrorMessage(reason: VoiceInputErrorReason): string {
    switch (reason) {
      case 'no-speech':
        return 'Не вдалося розпізнати мовлення — нічого не почув. Спробуйте ще раз ближче до мікрофона.';
      case 'not-allowed':
        return 'Доступ до мікрофона заборонено. Дозвольте доступ у налаштуваннях браузера.';
      case 'network':
        return 'Немає з’єднання для розпізнавання мовлення. Перевірте інтернет і спробуйте ще раз.';
      default:
        return 'Не вдалося розпізнати мовлення. Спробуйте ще раз.';
    }
  }
}
