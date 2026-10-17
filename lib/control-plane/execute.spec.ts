import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchProduct } from '../agent/pick-product';
import type { PlanDecision } from './plan';
import type { Run } from './types';

const mocks = vi.hoisted(() => ({
  getMyShoppingCart: vi.fn(),
  getShoppingCartById: vi.fn(),
  addOrUpdateCartProducts: vi.fn(),
  removeCartProducts: vi.fn(),
  findProductsBatch: vi.fn(),
  requireCartContext: vi.fn(),
  setupCartForAddress: vi.fn(),
}));

vi.mock('../mcp/silpo-tools', () => mocks);

const { executeStep } = await import('./execute');

const RUN: Run = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'running',
  input: { address: 'вул. Хрещатик 1', request: 'молоко' },
  createdAt: 0,
  updatedAt: 0,
};

const CTX = { sessionId: 'session-1', anthropicClient: undefined };

const PRODUCT: SearchProduct = { id: 'p1', name: 'Молоко', price: 42, stock: 10, image: '', companyId: 'c1', branchId: 'b1' };

function cartWith(products: Array<{ productId: string; quantity: number; name?: string }>) {
  return {
    cart: {
      deliveryType: 'DeliveryHome',
      timeslot: { start: '', end: '' },
      address: {},
      shipments: [{ branchId: 'b1', companyId: 'c1', products }],
      calculation: { total: 0, totalAfterDiscounts: 0, validations: [] },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyShoppingCart.mockResolvedValue({ exists: true, shoppingCartId: 'cart-1' });
});

describe('executeStep cart_write idempotency', () => {
  it('does nothing when the picked product is already in the cart with the right quantity', async () => {
    mocks.getShoppingCartById.mockResolvedValue(cartWith([{ productId: 'p1', quantity: 1, name: 'Молоко' }]));

    const decision: Extract<PlanDecision, { kind: 'cart_write' }> = {
      kind: 'cart_write',
      index: 0,
      itemKey: '0:молоко',
      item: { type: 'add', query: 'молоко', quantity: 1 },
      picked: PRODUCT,
    };

    const step = await executeStep(RUN, [], decision, CTX);

    expect(step.status).toBe('succeeded');
    expect(mocks.addOrUpdateCartProducts).not.toHaveBeenCalled();
    expect(mocks.removeCartProducts).not.toHaveBeenCalled();
    expect(mocks.getShoppingCartById).toHaveBeenCalledTimes(1);
  });

  it('removes the replace target when it is still present, then adds the new item', async () => {
    mocks.getShoppingCartById
      .mockResolvedValueOnce(cartWith([{ productId: 'old', quantity: 1, name: 'Булка' }]))
      .mockResolvedValueOnce(cartWith([{ productId: 'p1', quantity: 2, name: 'Молоко' }]));
    mocks.removeCartProducts.mockResolvedValue({});
    mocks.addOrUpdateCartProducts.mockResolvedValue({});

    const decision: Extract<PlanDecision, { kind: 'cart_write' }> = {
      kind: 'cart_write',
      index: 0,
      itemKey: '0:молоко',
      item: { type: 'replace', target: 'булка', query: 'молоко', quantity: 2 },
      picked: PRODUCT,
    };

    const step = await executeStep(RUN, [], decision, CTX);

    expect(step.status).toBe('succeeded');
    expect(mocks.removeCartProducts).toHaveBeenCalledWith('session-1', 'cart-1', ['old']);
    expect(mocks.addOrUpdateCartProducts).toHaveBeenCalledTimes(1);
  });

  it('skips the removal without failing when the replace target is already gone', async () => {
    mocks.getShoppingCartById
      .mockResolvedValueOnce(cartWith([])) // target already removed by an earlier crashed attempt
      .mockResolvedValueOnce(cartWith([{ productId: 'p1', quantity: 2, name: 'Молоко' }]));
    mocks.addOrUpdateCartProducts.mockResolvedValue({});

    const decision: Extract<PlanDecision, { kind: 'cart_write' }> = {
      kind: 'cart_write',
      index: 0,
      itemKey: '0:молоко',
      item: { type: 'replace', target: 'булка', query: 'молоко', quantity: 2 },
      picked: PRODUCT,
    };

    const step = await executeStep(RUN, [], decision, CTX);

    expect(step.status).toBe('succeeded');
    expect(mocks.removeCartProducts).not.toHaveBeenCalled();
    expect(mocks.addOrUpdateCartProducts).toHaveBeenCalledTimes(1);
  });
});
