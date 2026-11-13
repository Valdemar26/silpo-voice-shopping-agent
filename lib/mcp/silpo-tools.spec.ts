import { beforeEach, describe, expect, it, vi } from 'vitest';

// The MCP client is mocked at the callMcpTool boundary — that keeps the
// OAuth/Redis chain out of the import, and lets the cart tests assert exactly
// which Silpo tool got called with what.
const { callMcpTool } = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock('./client', () => ({ callMcpTool }));

import {
  addOrUpdateCartProducts,
  AddressAmbiguousError,
  AddressHouseNotConfirmedError,
  pickAddressCandidate,
  removeCartProducts,
  type ResolvedAddress,
} from './silpo-tools';

function mockCart(lines: Array<{ id?: string; productId: string; quantity: number }>) {
  callMcpTool.mockImplementation(async (_sessionId: string, tool: string) => {
    if (tool === 'silpo_get_shopping_cart_by_id') {
      return { cart: { shipments: [{ branchId: 'b1', companyId: 'c1', products: lines.map((l) => ({ companyId: 'c1', ...l })) }] } };
    }
    return { success: true };
  });
}

function writes() {
  return callMcpTool.mock.calls.filter(([, tool]) => tool !== 'silpo_get_shopping_cart_by_id');
}

// Live silpo_find_address response for "Львів, Малоголосківська вулиця, 8є".
const BUILDING: ResolvedAddress = {
  address: 'Львів, Малоголосківська вулиця, 8-Є',
  city: 'Львів',
  street: 'Малоголосківська вулиця',
  houseNumber: '8-Є',
  district: 'Голоско',
  latitude: 49.866363,
  longitude: 24.004177904233718,
};

const VENUE_IN_BUILDING: ResolvedAddress = {
  address: 'Львів, Малоголосківська вулиця, 8-Є, Food market',
  city: 'Львів',
  street: 'Малоголосківська вулиця',
  houseNumber: '8-Є',
  district: 'Голоско',
  latitude: 49.8662447,
  longitude: 24.0041473,
};

describe('pickAddressCandidate', () => {
  it('collapses the building and a venue inside it, picking the entry without the venue suffix', () => {
    expect(pickAddressCandidate([VENUE_IN_BUILDING, BUILDING])).toEqual(BUILDING);
    expect(pickAddressCandidate([BUILDING, VENUE_IN_BUILDING])).toEqual(BUILDING);
  });

  it('stays ambiguous for different houses on the same street ("8" vs "8-Є"), listing both in the message', () => {
    const house8: ResolvedAddress = {
      ...BUILDING,
      address: 'Львів, Малоголосківська вулиця, 8',
      houseNumber: '8',
      latitude: 49.8665,
      longitude: 24.0043,
    };

    let error: unknown;
    try {
      pickAddressCandidate([house8, BUILDING]);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AddressAmbiguousError);
    expect((error as AddressAmbiguousError).candidates).toEqual([house8, BUILDING]);
    expect((error as Error).message).toContain('"Львів, Малоголосківська вулиця, 8"');
    expect((error as Error).message).toContain('"Львів, Малоголосківська вулиця, 8-Є"');
  });

  it('rejects a candidate whose house number find_address could not confirm', () => {
    const streetOnly: ResolvedAddress = {
      ...BUILDING,
      address: 'Львів, Малоголосківська вулиця',
      houseNumber: null,
    };

    expect(() => pickAddressCandidate([streetOnly])).toThrow(AddressHouseNotConfirmedError);
  });
});

describe('addOrUpdateCartProducts', () => {
  const MILK = { productId: 'p-milk', companyId: 'c1', branchId: 'b1', quantity: 2 };
  const BREAD = { productId: 'p-bread', companyId: 'c1', branchId: 'b1', quantity: 1 };

  beforeEach(() => callMcpTool.mockReset());

  it('adds a product that is not in the cart yet via silpo_add_cart_products, without legacy fields', async () => {
    mockCart([]);

    await addOrUpdateCartProducts('s1', 'cart-1', [{ ...MILK, addQuantity: false } as typeof MILK]);

    expect(writes()).toEqual([
      ['s1', 'silpo_add_cart_products', { shoppingCartId: 'cart-1', products: [MILK] }],
    ]);
  });

  it('sets (not adds) the quantity of a product already in the cart via its line-item id', async () => {
    mockCart([{ id: 'line-milk', productId: 'p-milk', quantity: 1 }]);

    await addOrUpdateCartProducts('s1', 'cart-1', [MILK]);

    // quantity is the requested total (2), not current+requested (3).
    expect(writes()).toEqual([
      ['s1', 'silpo_update_cart_products', { shoppingCartId: 'cart-1', products: [{ id: 'line-milk', quantity: 2 }] }],
    ]);
  });

  it('splits a mixed batch between update and add', async () => {
    mockCart([{ id: 'line-milk', productId: 'p-milk', quantity: 1 }]);

    await addOrUpdateCartProducts('s1', 'cart-1', [MILK, BREAD]);

    expect(writes()).toEqual([
      ['s1', 'silpo_update_cart_products', { shoppingCartId: 'cart-1', products: [{ id: 'line-milk', quantity: 2 }] }],
      ['s1', 'silpo_add_cart_products', { shoppingCartId: 'cart-1', products: [BREAD] }],
    ]);
  });

  it('refuses to write anything when an existing cart line has no line-item id', async () => {
    mockCart([{ productId: 'p-milk', quantity: 1 }]);

    await expect(addOrUpdateCartProducts('s1', 'cart-1', [BREAD, MILK])).rejects.toThrow(/no line-item id/);
    expect(writes()).toEqual([]);
  });
});

describe('removeCartProducts', () => {
  beforeEach(() => callMcpTool.mockReset());

  it('removes by cart line-item id, not productId', async () => {
    mockCart([
      { id: 'line-milk', productId: 'p-milk', quantity: 1 },
      { id: 'line-bread', productId: 'p-bread', quantity: 1 },
    ]);

    await removeCartProducts('s1', 'cart-1', ['p-milk']);

    expect(writes()).toEqual([
      ['s1', 'silpo_remove_cart_products', { shoppingCartId: 'cart-1', products: [{ id: 'line-milk' }] }],
    ]);
  });

  it('skips products that are no longer in the cart and removes the rest', async () => {
    mockCart([{ id: 'line-bread', productId: 'p-bread', quantity: 1 }]);

    await removeCartProducts('s1', 'cart-1', ['p-milk', 'p-bread']);

    expect(writes()).toEqual([
      ['s1', 'silpo_remove_cart_products', { shoppingCartId: 'cart-1', products: [{ id: 'line-bread' }] }],
    ]);
  });

  it('makes no remove call when none of the products are in the cart', async () => {
    mockCart([]);

    await removeCartProducts('s1', 'cart-1', ['p-milk']);

    expect(writes()).toEqual([]);
  });

  it('refuses to remove anything when a matching cart line has no line-item id', async () => {
    mockCart([
      { id: 'line-bread', productId: 'p-bread', quantity: 1 },
      { productId: 'p-milk', quantity: 1 },
    ]);

    await expect(removeCartProducts('s1', 'cart-1', ['p-bread', 'p-milk'])).rejects.toThrow(/no line-item id/);
    expect(writes()).toEqual([]);
  });
});
