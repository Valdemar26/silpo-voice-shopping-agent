import { defineConfig } from 'vitest/config';

// Separate from Angular's own `ng test` (vitest via @angular/build:unit-test,
// scoped to src/**/*.spec.ts) — this one covers plain TS code under lib/
// that has no Angular/DOM dependency, run via `npm run test:lib`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts'],
  },
});
