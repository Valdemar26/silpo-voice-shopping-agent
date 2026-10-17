// Pure summary-text builder — no Angular, no fetch. Moved out of
// SilpoAgentService (src/app/services/silpo-agent.ts) so the control-plane's
// finalize step (lib/control-plane/execute.ts) can build the exact same
// spoken summary server-side instead of the client re-deriving it from a
// journal it already has.
import type { ApprovalItem } from '../control-plane/plan';
import type { CartState } from './cart-state';

// One product actually added to the cart during a single run — used to scope
// the spoken summary to just this run instead of the cart's whole (possibly
// older) contents. price is the unit price as returned by search, same
// semantics as CartProduct.price.
export interface AddedItem {
  name: string;
  quantity: number;
  price: number;
}

// Short spoken recap read out over TTS once the run finishes — scoped to
// just what THIS run added, not the cart's whole (possibly older) contents,
// so a second run doesn't re-announce items added in a previous one. Kept
// separate from the visible result panel, which always shows the full
// current cart regardless of what this run touched.
export function buildSpokenSummary(state: CartState, addedItems: AddedItem[], hadItemsBefore: boolean): string {
  if (addedItems.length === 0) {
    const cartHasItems = state.cart.shipments.some((s) => s.products.length > 0);
    return cartHasItems ? 'Нічого нового не додав.' : 'Нічого не знайшов. Кошик лишився порожнім.';
  }

  const names = addedItems.map((i) => i.name);
  const grandTotal = Math.round(state.cart.calculation.totalAfterDiscounts);

  // Only worth splitting into "new items / grand total" when the cart
  // wasn't empty going into this run — otherwise the two numbers are the
  // same order (the whole cart IS what was just added, delivery fee aside)
  // and a second sentence just repeats itself.
  if (hadItemsBefore) {
    const newItemsTotal = Math.round(addedItems.reduce((sum, i) => sum + i.price * i.quantity, 0));
    return (
      `Додав ${joinWithI(names)}, разом ${newItemsTotal} ${pluralizeHryvnia(newItemsTotal)} за нові позиції. ` +
      `Загальна сума кошика — ${grandTotal} ${pluralizeHryvnia(grandTotal)}.`
    );
  }
  return `Додав ${joinWithI(names)}, разом ${grandTotal} ${pluralizeHryvnia(grandTotal)}.`;
}

// Spoken when a run pauses for approval — called client-side
// (SilpoAgentService) straight off the 'approval' decision's own items,
// unlike buildSpokenSummary which needs a fresh CartState only the server
// has at that point.
export function buildApprovalPrompt(items: ApprovalItem[]): string {
  const total = Math.round(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
  return `Знайшов ${items.length} ${pluralizeProducts(items.length)} на ${total} ${pluralizeHryvnia(total)}. Підтвердіть, будь ласка.`;
}

function joinWithI(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} і ${items[items.length - 1]}`;
}

// Ukrainian grammatical number agreement for "гривня" (1 гривня, 2 гривні, 5 гривень, ...).
function pluralizeHryvnia(amount: number): string {
  const mod100 = Math.abs(amount) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return 'гривень';
  if (mod10 === 1) return 'гривня';
  if (mod10 >= 2 && mod10 <= 4) return 'гривні';
  return 'гривень';
}

// Same mod10/mod100 agreement as pluralizeHryvnia, for "товар"
// (1 товар, 2 товари, 5 товарів, ...).
function pluralizeProducts(count: number): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return 'товарів';
  if (mod10 === 1) return 'товар';
  if (mod10 >= 2 && mod10 <= 4) return 'товари';
  return 'товарів';
}
