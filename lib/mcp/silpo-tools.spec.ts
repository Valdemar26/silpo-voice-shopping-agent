import { describe, expect, it, vi } from 'vitest';

// pickAddressCandidate is pure — the MCP client is mocked only so importing
// silpo-tools doesn't pull in the OAuth/Redis chain.
vi.mock('./client', () => ({ callMcpTool: vi.fn() }));

import {
  AddressAmbiguousError,
  AddressHouseNotConfirmedError,
  pickAddressCandidate,
  type ResolvedAddress,
} from './silpo-tools';

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
