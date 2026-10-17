import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import type { ApprovalItem } from '../../../../lib/control-plane/plan';

// Shown while a run is paused in 'waiting_approval' — lets the person drop
// individual finds before anything is written to the cart. All items start
// checked; unchecking one excludes it from the approve() call entirely (it's
// never retried later, see lib/control-plane/plan.ts's planNext).
@Component({
  selector: 'app-approval-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './approval-panel.scss',
  template: `
    <fieldset class="approval-panel" data-cy="approval-panel">
      <legend>Підтвердіть додавання товарів</legend>

      <ul class="approval-list">
        @for (item of items(); track item.itemKey) {
          <li class="approval-item">
            <label>
              <input
                type="checkbox"
                [checked]="isChecked(item.itemKey)"
                [disabled]="busy()"
                (change)="toggle(item.itemKey)"
                data-cy="approval-checkbox"
              />
              <span>{{ itemLabel(item) }} × {{ item.quantity }} — {{ item.price * item.quantity }} ₴</span>
            </label>
          </li>
        }
      </ul>

      <p class="approval-total" data-cy="approval-total">Разом вибрано: {{ selectedTotal() }} ₴</p>

      <div class="approval-actions">
        <button
          type="button"
          class="approval-confirm-btn"
          [disabled]="!canConfirm()"
          (click)="onConfirm()"
          data-cy="approve-btn"
        >
          Підтвердити
        </button>
        <button
          type="button"
          class="approval-cancel-btn"
          [disabled]="busy()"
          (click)="onCancel()"
          data-cy="reject-btn"
        >
          Скасувати
        </button>
      </div>
    </fieldset>
  `,
})
export class ApprovalPanelComponent {
  readonly items = input.required<ApprovalItem[]>();
  readonly busy = input(false);

  readonly confirm = output<string[]>();
  readonly cancel = output<void>();

  // Derived from items() but locally overridable — resets to "everything
  // checked" whenever a new approval round hands in a new items() array,
  // while toggle() below keeps its own edits until that happens.
  protected readonly selected = linkedSignal<ReadonlySet<string>>(() => new Set(this.items().map((i) => i.itemKey)));

  protected readonly selectedTotal = computed(() =>
    this.items()
      .filter((i) => this.selected().has(i.itemKey))
      .reduce((sum, i) => sum + i.price * i.quantity, 0),
  );

  protected readonly canConfirm = computed(() => this.selected().size > 0 && !this.busy());

  protected isChecked(itemKey: string): boolean {
    return this.selected().has(itemKey);
  }

  protected toggle(itemKey: string): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) {
        next.delete(itemKey);
      } else {
        next.add(itemKey);
      }
      return next;
    });
  }

  // "Заміна: «target» → «назва»" for a replace so the person sees the
  // removal half of the action too, plain name otherwise.
  protected itemLabel(item: ApprovalItem): string {
    return item.type === 'replace' ? `Заміна: «${item.target}» → «${item.name}»` : item.name;
  }

  protected onConfirm(): void {
    this.confirm.emit([...this.selected()]);
  }

  protected onCancel(): void {
    this.cancel.emit();
  }
}
