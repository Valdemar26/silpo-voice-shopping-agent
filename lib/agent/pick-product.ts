// Pure candidate-selection logic for turning a find_products_batch result into
// one picked product — no Angular, no fetch, no DOM. Extracted out of
// SilpoAgentService.searchAndPickProduct (src/app/services/silpo-agent.ts) so
// the exact decision logic (not a re-implementation of it) is importable from
// a plain Node context too, e.g. evals/runner.ts.

// Only 'discount' is implemented — other criteria the LLM might recognize are
// still dropped upstream in api/agent/parse-items.ts.
export type Selector = 'discount';

// Shape returned by silpo_find_products_batch (via /api/mcp/products/search).
// oldPrice/specialPrices confirmed against a live search response — oldPrice
// is the pre-discount price (null when not discounted), specialPrices is a
// list of quantity-break prices (e.g. "76.90 ₴ from 2 pcs", null otherwise).
export interface SearchProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  image: string;
  companyId: string;
  branchId: string;
  oldPrice?: number | null;
  specialPrices?: Array<{ price: number; count: number; type: string }> | null;
}

// True when a candidate is actually on sale: either marked down from an
// oldPrice, or carrying a quantity-break specialPrices entry.
export function isOnDiscount(p: SearchProduct): boolean {
  if (typeof p.oldPrice === 'number' && p.oldPrice > p.price) return true;
  return !!p.specialPrices && p.specialPrices.length > 0;
}

// selector: "discount" picks the first candidate that's actually on sale,
// falling back to the plain first result (and noting the miss in the trace
// via describePick) when none of the returned candidates qualify.
export function pickBySelector(candidates: SearchProduct[], selector?: Selector): SearchProduct {
  if (selector === 'discount') {
    const discounted = candidates.find(isOnDiscount);
    if (discounted) return discounted;
  }
  return candidates[0];
}

// Middle value of the candidates' prices — used to spot a single outlier
// among otherwise-similar results (candidates.length is capped at 5, so this
// is cheap and doesn't need a proper selection algorithm).
export function medianPrice(candidates: SearchProduct[]): number {
  const prices = candidates.map((c) => c.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

export function formatDiscount(p: SearchProduct): string {
  if (typeof p.oldPrice === 'number' && p.oldPrice > p.price) {
    return `було ${p.oldPrice} ₴, стало ${p.price} ₴`;
  }
  const special = p.specialPrices?.[0];
  if (special) {
    return `знижка від ${special.count} шт.: ${special.price} ₴`;
  }
  return `${p.price} ₴`;
}

export function describeProduct(p: SearchProduct): string {
  return `${p.name} — ${p.price} ₴ (залишок: ${p.stock})`;
}

// Trace detail for a search step: plain description when there's no
// selector, otherwise reports whether the "discount" criterion was actually
// satisfied among the returned candidates or the plain first result was used
// instead.
export function describePick(first: SearchProduct, picked: SearchProduct, selector?: Selector): string {
  if (selector !== 'discount') return describeProduct(picked);

  if (picked !== first) {
    return `знайдено на знижці: ${picked.name}, ${formatDiscount(picked)}`;
  }
  if (isOnDiscount(picked)) {
    return `знайдено на знижці: ${picked.name}, ${formatDiscount(picked)}`;
  }
  return `критерій «акція» не задоволено — взято перший знайдений товар: ${describeProduct(picked)}`;
}

export interface PickOutcome {
  picked: SearchProduct | null;
  reason: 'no_candidates' | 'not_relevant' | 'ok';
  detail: string;
  // True whenever the price-anomaly fallback fired, regardless of the final
  // reason — mirrors searchAndPickProduct, which registers discount
  // alternatives for an anomaly-triggered pick even when the relevance check
  // rejects it afterwards.
  anomalyDetected: boolean;
}

/**
 * candidates -> one picked product, or a reason nothing was picked. Mirrors
 * SilpoAgentService.searchAndPickProduct's decision logic line-for-line
 * (src/app/services/silpo-agent.ts) minus the network calls and Angular
 * signals/trace-step bookkeeping, which stay on the class. checkRelevance is
 * injected so callers can use the real LLM check (production, evals) or a
 * stub (unit tests).
 */
export async function selectProduct(
  candidates: SearchProduct[],
  selector: Selector | undefined,
  query: string,
  checkRelevance: (query: string, candidateName: string) => Promise<boolean>,
): Promise<PickOutcome> {
  if (candidates.length === 0) {
    return { picked: null, reason: 'no_candidates', detail: 'Нічого не знайдено', anomalyDetected: false };
  }

  let found = pickBySelector(candidates, selector);
  let anomalyNote: string | null = null;

  // No selector at all ("plain add", e.g. a query like "віскі Ballantine's")
  // — find_products_batch's top hit can be an isolated outlier (a premium
  // bottle costing several times the rest of the returned candidates for the
  // same query). Rather than silently adding that to the cart, fall back to
  // the cheapest candidate and surface the expensive one as a muted
  // alternative instead.
  if (!selector && candidates.length > 1) {
    const median = medianPrice(candidates);
    const expensive = candidates[0];
    if (median > 0 && expensive.price > median * 5) {
      anomalyNote = `обрано ближче до типової ціни — «${expensive.name}» була значно дорожчою за інші варіанти`;
      found = candidates.reduce((cheapest, c) => (c.price < cheapest.price ? c : cheapest));
    }
  }

  const anomalyDetected = anomalyNote !== null;

  // Safety net independent of any selector — find_products_batch's own
  // relevance can be poor (e.g. "гречка" surfacing a candy bar whose *flavor*
  // happens to be named "гречка-вишня" as its top hit). Checked on whichever
  // candidate was actually picked, not just candidates[0], so it also covers
  // the discount fallback path.
  if (!(await checkRelevance(query, found.name))) {
    return {
      picked: null,
      reason: 'not_relevant',
      detail: `«${query}» — знайдені результати не відповідають запиту, товар не додано`,
      anomalyDetected,
    };
  }

  const pickDetail = describePick(candidates[0], found, selector);
  return {
    picked: found,
    reason: 'ok',
    detail: anomalyNote ? `${pickDetail}; ${anomalyNote}` : pickDetail,
    anomalyDetected,
  };
}
