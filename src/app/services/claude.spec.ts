import { TestBed } from '@angular/core/testing';

import { Claude } from './claude';

describe('Claude', () => {
  let service: Claude;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Claude);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
