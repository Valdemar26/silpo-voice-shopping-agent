import { describe, expect, it } from 'vitest';
import { getOrderDiscount, type SilpoCart } from './cart-state';

function cart(calculation: Partial<SilpoCart['calculation']>): SilpoCart {
  return {
    deliveryType: 'DeliveryHome',
    timeslot: { start: '', end: '' },
    shipments: [],
    calculation: { total: 0, totalAfterDiscounts: 0, productsTotal: 0, validations: [], ...calculation },
  };
}

describe('getOrderDiscount', () => {
  it('derives the order-level discount from products + delivery minus the final total', () => {
    // Live cart: beer line with its own oldPrice markdown plus a separate
    // "buy more, save more" promo — calculation.subDiscount reported 350
    // (50 + 300), already folded into productsTotal. The order-level
    // discount actually applied on top is just productsTotal + delivery −
    // totalAfterDiscounts.
    const state = cart({ productsTotal: 850, delivery: { total: 49 }, totalAfterDiscounts: 849 });

    expect(getOrderDiscount(state)).toBe(50);
  });

  it('is 0 when nothing beyond per-item pricing was discounted', () => {
    const state = cart({ productsTotal: 500, delivery: { total: 49 }, totalAfterDiscounts: 549 });

    expect(getOrderDiscount(state)).toBe(0);
  });

  it('treats a missing delivery object as free delivery (0)', () => {
    const state = cart({ productsTotal: 300, totalAfterDiscounts: 300 });

    expect(getOrderDiscount(state)).toBe(0);
  });
});
