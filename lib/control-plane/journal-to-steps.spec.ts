import { describe, expect, it } from 'vitest';
import type { SearchProduct } from '../agent/pick-product';
import { journalToAgentSteps } from './journal-to-steps';
import { makeItemKey } from './plan';
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

const MILK: SearchProduct = { id: 'p1', name: 'Молоко', price: 42, stock: 10, image: '', companyId: 'c1', branchId: 'b1' };
const BREAD: SearchProduct = { id: 'p2', name: 'Хліб', price: 25, stock: 5, image: '', companyId: 'c1', branchId: 'b1' };

describe('journalToAgentSteps', () => {
  it('projects a full successful journal into the matching AgentStep list', () => {
    const steps: Step[] = [
      step({
        kind: 'setup_cart',
        status: 'succeeded',
        output: {
          shoppingCartId: 'cart-1',
          trace: [
            { step: 'find_address', detail: 'вул. Хрещатик 1 (50.45, 30.52)' },
            { step: 'ensure_shopping_cart', detail: 'deliveryType=DeliveryHome, shoppingCartId=cart-1' },
          ],
        },
      }),
      step({
        kind: 'parse',
        status: 'succeeded',
        output: {
          items: [
            { type: 'add', query: 'молоко', quantity: 1 },
            { type: 'add', query: 'нічогонема', quantity: 1 },
          ],
        },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        input: { kind: 'select_product', index: 0, itemKey: makeItemKey(0, 'молоко'), item: { type: 'add', query: 'молоко', quantity: 1 } },
        output: { picked: MILK, reason: 'ok', detail: 'Молоко — 42 ₴ (залишок: 10)', candidates: [MILK], anomalyDetected: false },
      }),
      step({
        kind: 'select_product',
        status: 'succeeded',
        itemKey: makeItemKey(1, 'нічогонема'),
        input: {
          kind: 'select_product',
          index: 1,
          itemKey: makeItemKey(1, 'нічогонема'),
          item: { type: 'add', query: 'нічогонема', quantity: 1 },
        },
        output: { picked: null, reason: 'no_candidates', detail: 'Нічого не знайдено', candidates: [], anomalyDetected: false },
      }),
      step({
        kind: 'cart_write',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'молоко'),
        input: {
          kind: 'cart_write',
          index: 0,
          itemKey: makeItemKey(0, 'молоко'),
          item: { type: 'add', query: 'молоко', quantity: 1 },
          picked: MILK,
        },
        output: { shoppingCartId: 'cart-1', productId: 'p1', name: 'Молоко', quantity: 1, price: 42, itemsInCart: 1 },
      }),
      step({
        kind: 'finalize',
        status: 'succeeded',
        output: {
          cartState: { shoppingCartId: 'cart-1', cart: { shipments: [], calculation: {} } },
          checkoutStatus: { canCheckout: true, belowMinimum: null, adultConfirmationRequired: false, stockExceeded: [], otherBlocked: false },
          spokenSummary: 'Додав Молоко, разом 42 гривні.',
        },
      }),
    ];

    expect(journalToAgentSteps(RUN, steps, null)).toEqual([
      { id: 'setup-cart', label: 'Налаштування кошика для адреси «вул. Хрещатик 1»', status: 'done', detail: 'Кошик cart-1' },
      { id: 'trace-0-find_address', label: 'find_address', status: 'done', detail: 'вул. Хрещатик 1 (50.45, 30.52)' },
      {
        id: 'trace-1-ensure_shopping_cart',
        label: 'ensure_shopping_cart',
        status: 'done',
        detail: 'deliveryType=DeliveryHome, shoppingCartId=cart-1',
      },
      { id: 'parse-query', label: 'Розбір запиту', status: 'done', detail: 'молоко, нічогонема' },
      { id: 'search-молоко', label: 'Пошук: «молоко»', status: 'done', detail: 'Молоко — 42 ₴ (залишок: 10)' },
      { id: 'search-нічогонема', label: 'Пошук: «нічогонема»', status: 'error', detail: 'Нічого не знайдено' },
      { id: 'add-p1', label: 'Додавання в кошик: «Молоко»', status: 'done' },
      { id: 'checkout-status', label: 'Кошик готовий до оформлення', status: 'done' },
    ]);
  });

  it('labels a replace cart_write as "Заміна: «target» → «new item»"', () => {
    const steps: Step[] = [
      step({
        kind: 'cart_write',
        status: 'succeeded',
        itemKey: makeItemKey(0, 'хліб'),
        input: {
          kind: 'cart_write',
          index: 0,
          itemKey: makeItemKey(0, 'хліб'),
          item: { type: 'replace', target: 'булка', query: 'хліб', quantity: 2 },
          picked: BREAD,
        },
        output: { shoppingCartId: 'cart-1', productId: 'p2', name: 'Хліб', quantity: 2, price: 25, itemsInCart: 1 },
      }),
    ];

    expect(journalToAgentSteps(RUN, steps, null)).toEqual([
      { id: 'add-p2', label: 'Заміна: «булка» → «Хліб × 2»', status: 'done' },
    ]);
  });

  it('appends a running row for the planned next step', () => {
    const next = { kind: 'select_product' as const, index: 0, itemKey: makeItemKey(0, 'хліб'), item: { type: 'add' as const, query: 'хліб', quantity: 1 } };

    expect(journalToAgentSteps(RUN, [], next)).toEqual([{ id: 'search-хліб', label: 'Пошук: «хліб»', status: 'running' }]);
  });

  it('shows setup_cart as running before any journal step exists', () => {
    expect(journalToAgentSteps(RUN, [], { kind: 'setup_cart' })).toEqual([
      { id: 'setup-cart', label: 'Налаштування кошика для адреси «вул. Хрещатик 1»', status: 'running' },
    ]);
  });

  it('shows a running placeholder while waiting for approval', () => {
    const next = {
      kind: 'approval' as const,
      items: [{ itemKey: makeItemKey(0, 'молоко'), name: 'Молоко', quantity: 1, price: 42, type: 'add' as const }],
    };

    expect(journalToAgentSteps(RUN, [], next)).toEqual([{ id: 'approval', label: 'Очікує підтвердження', status: 'running' }]);
  });

  it('labels a partially approved approval step as "Підтверджено: N з M"', () => {
    const steps: Step[] = [
      step({
        kind: 'approval',
        status: 'succeeded',
        input: {
          kind: 'approval',
          items: [
            { itemKey: makeItemKey(0, 'молоко'), name: 'Молоко', quantity: 1, price: 42, type: 'add' },
            { itemKey: makeItemKey(1, 'хліб'), name: 'Хліб', quantity: 2, price: 25, type: 'add' },
          ],
        },
        output: { approved: true, approvedItemKeys: [makeItemKey(0, 'молоко')] },
      }),
    ];

    expect(journalToAgentSteps(RUN, steps, null)).toEqual([{ id: 'approval', label: 'Підтверджено: 1 з 2', status: 'done' }]);
  });

  it('labels a rejected approval step as "Скасовано користувачем"', () => {
    const steps: Step[] = [
      step({
        kind: 'approval',
        status: 'succeeded',
        input: {
          kind: 'approval',
          items: [{ itemKey: makeItemKey(0, 'молоко'), name: 'Молоко', quantity: 1, price: 42, type: 'add' }],
        },
        output: { approved: false, approvedItemKeys: [] },
      }),
    ];

    expect(journalToAgentSteps(RUN, steps, null)).toEqual([{ id: 'approval', label: 'Скасовано користувачем', status: 'done' }]);
  });
});
