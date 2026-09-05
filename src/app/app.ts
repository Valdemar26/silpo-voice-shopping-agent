import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import { CartProduct, SilpoAgentService } from './services/silpo-agent';

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
}
