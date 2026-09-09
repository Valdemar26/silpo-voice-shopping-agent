import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgOptimizedImage } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import { GeolocationService } from './services/geolocation';
import { MicLevelService } from './services/mic-level';
import {
  buildShareText,
  CartProduct,
  getCheckoutStatus,
  SearchProduct,
  SilpoAgentService,
  StockExceededItem,
} from './services/silpo-agent';
import { ShareService } from './services/share';
import { SpeechRecognitionService, VoiceInputErrorReason } from './services/speech-recognition';

@Component({
  selector: 'app-root',
  imports: [ReactiveFormsModule, NgOptimizedImage],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly fb = inject(FormBuilder);
  protected readonly agent = inject(SilpoAgentService);
  protected readonly speech = inject(SpeechRecognitionService);
  protected readonly micLevel = inject(MicLevelService);
  private readonly share = inject(ShareService);
  private readonly geolocation = inject(GeolocationService);

  protected readonly voiceError = signal<string | null>(null);
  protected readonly shareFeedback = signal<{ text: string; ok: boolean } | null>(null);
  protected readonly geoLocating = signal(false);
  protected readonly geoError = signal<string | null>(null);
  protected readonly geoWarning = signal<string | null>(null);

  constructor() {
    // Keyed off speech.listening() rather than called inline in
    // toggleVoiceInput() — recognition can also stop on its own (silence
    // timeout), and this way the visualizer's start/stop always tracks the
    // real listening state regardless of which path ended it.
    effect(() => {
      if (this.speech.listening()) {
        void this.micLevel.start();
      } else {
        this.micLevel.stop();
      }
    });
  }

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

  // Deliberately reads raw values rather than formStatus(): the aggregate
  // group status stays "INVALID" (same string) while only address flips from
  // invalid to valid — since request is still empty — and a signal derived
  // from statusChanges doesn't notify on an unchanged value, so that reason
  // would get stuck. Values themselves change on every keystroke instead.
  private readonly formValue = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  // Explains why the button is disabled instead of leaving the user to guess —
  // same principle as the rest of the app's explicit-failure-over-silence approach.
  protected readonly runBlockedReason = computed<string | null>(() => {
    if (this.agent.running()) return null;
    const { address, request } = this.formValue();
    if (!address?.trim()) return 'Заповніть адресу доставки, щоб продовжити.';
    if (!request?.trim()) return 'Заповніть поле «Що потрібно», щоб продовжити.';
    return null;
  });

  protected readonly cartItems = computed<CartProduct[]>(
    () => this.agent.result()?.cart.shipments.flatMap((s) => s.products) ?? [],
  );

  // Only items originally added with selector: "discount" have a stored
  // candidate group at all — a plain "add" never shows alternatives.
  protected getAlternatives(item: CartProduct): SearchProduct[] {
    const group = this.agent.discountAlternatives().get(item.productId);
    if (!group) return [];
    return group.filter((c) => c.id !== item.productId).slice(0, 3);
  }

  protected switchAlternative(item: CartProduct, alternative: SearchProduct): void {
    void this.agent.switchToAlternative(item.productId, alternative, item.quantity);
  }

  // Drives which of the checkout button / "add ₴N more" / adult-confirmation
  // note / blocked message the result panel shows. Reactive to
  // agent.result(), so removing an item (which can drop the cart back below
  // order.cost.min) updates this immediately too — not just right after a run.
  private readonly checkoutStatus = computed(() => {
    const result = this.agent.result();
    return result ? getCheckoutStatus(result) : null;
  });

  // Ready to show the checkout button — true for a fully clean cart, and
  // also when the only outstanding issue is order.adult.is_not_confirmed,
  // since Silpo defers that confirmation to the checkout page itself rather
  // than blocking checkoutWebLink.
  protected readonly isCheckoutReady = computed(
    () => this.checkoutStatus()?.kind === 'ready' || this.checkoutStatus()?.kind === 'adult-confirmation-required',
  );

  protected readonly needsAdultConfirmation = computed(() => this.checkoutStatus()?.kind === 'adult-confirmation-required');

  protected readonly isBelowMinimum = computed(() => this.checkoutStatus()?.kind === 'below-minimum');

  protected readonly isStockExceeded = computed(() => this.checkoutStatus()?.kind === 'stock-exceeded');

  protected readonly stockExceededItems = computed<StockExceededItem[]>(() => {
    const status = this.checkoutStatus();
    return status?.kind === 'stock-exceeded' ? status.items : [];
  });

  protected readonly amountRemainingForCheckout = computed<number>(() => {
    const status = this.checkoutStatus();
    return status?.kind === 'below-minimum' ? status.remaining : 0;
  });

  protected readonly minimumOrderProgress = computed<number>(() => {
    const status = this.checkoutStatus();
    return status?.kind === 'below-minimum' ? Math.round(status.percent) : 0;
  });

  // Doesn't touch the run/result flow at all — just hands the already-built
  // cart off to whoever's paying. Native share sheet gives its own feedback
  // on success, so only the clipboard fallback (and outright failure) need a
  // message here.
  protected async shareOrder(): Promise<void> {
    const result = this.agent.result();
    if (!result?.checkoutWebLink) return;

    const outcome = await this.share.share(buildShareText(result));
    if (outcome === 'copied') {
      this.shareFeedback.set({ text: 'Скопійовано в буфер обміну.', ok: true });
    } else if (outcome === 'failed') {
      this.shareFeedback.set({ text: 'Не вдалося поділитися — спробуй ще раз.', ok: false });
    } else {
      return;
    }
    setTimeout(() => this.shareFeedback.set(null), 3000);
  }

  // silpo_find_address only takes free text, no coordinate search — so this
  // reverse-geocodes via the backend and drops the result straight into the
  // address field, still editable before running, same as the mic transcript.
  protected async useMyLocation(): Promise<void> {
    this.geoError.set(null);
    this.geoWarning.set(null);
    this.geoLocating.set(true);

    try {
      const position = await this.geolocation.getCurrentPosition();

      if (position.kind === 'unsupported') {
        this.geoError.set('Геолокація не підтримується у цьому браузері. Введіть адресу вручну.');
        return;
      }
      if (position.kind === 'denied') {
        this.geoError.set('Доступ до геолокації заборонено. Дозвольте доступ у налаштуваннях браузера або введіть адресу вручну.');
        return;
      }
      if (position.kind === 'unavailable') {
        this.geoError.set('Не вдалося визначити місцезнаходження. Спробуйте ще раз або введіть адресу вручну.');
        return;
      }

      const response = await fetch('/api/geo/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: position.latitude, longitude: position.longitude }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.geoError.set(data?.error ?? 'Не вдалося визначити адресу за координатами.');
        return;
      }

      this.form.controls.address.setValue(data.address);
      // GPS often lands near, not exactly on, a mapped building — Nominatim
      // then resolves only to street level. Handing that over silently would
      // surface as a confusing "2 candidates" ambiguity from find_address
      // much later; say it plainly now instead, while it's still editable.
      if (data.houseNumberMissing) {
        this.geoWarning.set('Вдалося визначити лише вулицю — номер будинку не розпізнано автоматично. Допишіть його вручну перед тим, як продовжити.');
      }
    } catch (e) {
      this.geoError.set(e instanceof Error ? e.message : 'Мережева помилка при визначенні адреси.');
    } finally {
      this.geoLocating.set(false);
    }
  }

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
