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

const BREAD: SearchProduct = {
  id: 'p2',
  name: 'Хліб',
  price: 25,
  stock: 5,
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

  it('returns an approval decision once every select_product is resolved, listing only picked items', () => {
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
      kind: 'approval',
      items: [
        { itemKey: makeItemKey(1, 'молоко'), name: 'Молоко', quantity: 1, price: 42, type: 'add', target: undefined },
      ],
    });
  });

  it('moves to cart_write only for approved itemKeys, then straight to finalize once no approved item remains', () => {
    const baseSteps: Step[] = [
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
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { picked: PRODUCT, reason: 'ok', detail: 'ok' },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(1, 'хліб'),
        output: { picked: BREAD, reason: 'ok', detail: 'ok' },
      }),
      step({
        kind: 'approval',
        status: 'succeeded',
        output: { approved: true, approvedItemKeys: [makeItemKey(0, 'молоко')] },
      }),
    ];

    expect(planNext(RUN, baseSteps)).toEqual({
      kind: 'cart_write',
      index: 0,
      itemKey: makeItemKey(0, 'молоко'),
      item: { type: 'add', query: 'молоко', quantity: 1 },
      picked: PRODUCT,
    });

    const afterCartWrite: Step[] = [
      ...baseSteps,
      step({
        kind: 'cart_write',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        output: { shoppingCartId: 'cart-1' },
      }),
    ];

    // хліб was never approved — skipped forever, straight to finalize.
    expect(planNext(RUN, afterCartWrite)).toEqual({ kind: 'finalize' });
  });

  it('a rejected approval ends the run without any cart_write', () => {
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
        kind: 'approval',
        status: 'succeeded',
        output: { approved: false, approvedItemKeys: [] },
      }),
    ];

    expect(planNext(RUN, steps)).toEqual({ kind: 'done' });
  });

  it('skips approval entirely and goes straight to finalize when nothing was found', () => {
    const steps: Step[] = [
      step({ kind: 'setup_cart', status: 'succeeded', output: { shoppingCartId: 'cart-1' } }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: { items: [{ type: 'add', query: 'нічогонема', quantity: 1 }] },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'нічогонема'),
        output: { picked: null, reason: 'no_candidates', detail: 'Нічого не знайдено' },
      }),
    ];

    expect(planNext(RUN, steps)).toEqual({ kind: 'finalize' });
  });

  it('moves to finalize once every approved item is resolved', () => {
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
        kind: 'approval',
        status: 'succeeded',
        output: { approved: true, approvedItemKeys: [makeItemKey(0, 'молоко')] },
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
        kind: 'approval',
        status: 'succeeded',
        output: { approved: true, approvedItemKeys: [makeItemKey(0, 'молоко')] },
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
