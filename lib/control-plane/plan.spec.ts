import { describe, expect, it } from 'vitest';
import type { SearchProduct } from '../agent/pick-product';
import { makeItemKey, planNext } from './plan';
import type { Run, Step } from './types';

const RUN: Run = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'running',
  input: { address: 'вул. Хрещатик 1', request: 'молоко і хліб' },
  createdAt: 0,
  updatedAt: 0,
};

function step(partial: Partial<Step> & Pick<Step, 'kind' | 'status'>): Step {
  return {
    runId: RUN.id,
    index: 0,
    attempt: 1,
    input: null,
    toolCalls: [],
    startedAt: 0,
    finishedAt: 0,
    ...partial,
  };
}

const PRODUCT: SearchProduct = {
  id: 'p1',
  name: 'Молоко',
  price: 42,
  stock: 10,
  image: '',
  companyId: 'c1',
  branchId: 'b1',
};

describe('planNext', () => {
  it('starts with setup_cart on an empty journal', () => {
    expect(planNext(RUN, [])).toEqual({ kind: 'setup_cart' });
  });

  it('moves to select_product for the first item after parse', () => {
    const steps: Step[] = [
      step({ kind: 'setup_cart', status: 'succeeded', output: { shoppingCartId: 'cart-1' } }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: {
          items: [
            { type: 'add', query: 'молоко', quantity: 1 },
            { type: 'add', query: 'хліб', quantity: 1 },
          ],
        },
      }),
    ];

    expect(planNext(RUN, steps)).toEqual({
      kind: 'select_product',
      index: 0,
      itemKey: makeItemKey(0, 'молоко'),
      item: { type: 'add', query: 'молоко', quantity: 1 },
    });
  });

  it('skips cart_write for an item whose select_product picked null', () => {
    const steps: Step[] = [
      step({ kind: 'setup_cart', status: 'succeeded', output: { shoppingCartId: 'cart-1' } }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: {
          items: [
            { type: 'add', query: 'нічогонема', quantity: 1 },
            { type: 'add', query: 'молоко', quantity: 1 },
          ],
        },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'нічогонема'),
        output: { picked: null, reason: 'no_candidates', detail: 'Нічого не знайдено' },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(1, 'молоко'),
        output: { picked: PRODUCT, reason: 'ok', detail: 'ok' },
      }),
    ];

    expect(planNext(RUN, steps)).toEqual({
      kind: 'cart_write',
      index: 1,
      itemKey: makeItemKey(1, 'молоко'),
      item: { type: 'add', query: 'молоко', quantity: 1 },
      picked: PRODUCT,
    });
  });

  it('moves to finalize once every item is resolved', () => {
    const steps: Step[] = [
      step({ kind: 'setup_cart', status: 'succeeded', output: { shoppingCartId: 'cart-1' } }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: { items: [{ type: 'add', query: 'молоко', quantity: 1 }] },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { picked: PRODUCT, reason: 'ok', detail: 'ok' },
      }),
      step({
        kind: 'cart_write',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { shoppingCartId: 'cart-1' },
      }),
    ];

    expect(planNext(RUN, steps)).toEqual({ kind: 'finalize' });
  });

  it('reports done once finalize has succeeded', () => {
    const steps: Step[] = [
      step({ kind: 'setup_cart', status: 'succeeded', output: { shoppingCartId: 'cart-1' } }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: { items: [{ type: 'add', query: 'молоко', quantity: 1 }] },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { picked: PRODUCT, reason: 'ok', detail: 'ok' },
      }),
      step({
        kind: 'cart_write',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { shoppingCartId: 'cart-1' },
      }),
      step({ kind: 'finalize', status: 'succeeded', output: { checkoutStatus: {} } }),
    ];

    expect(planNext(RUN, steps)).toEqual({ kind: 'done' });
  });
});
