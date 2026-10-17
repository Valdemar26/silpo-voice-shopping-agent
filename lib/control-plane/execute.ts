// Runs exactly one control-plane step via the existing lib/ functions — the
// decision logic itself (setupCartForAddress, parseItemsWithClient,
// selectProduct, the cart mutation calls) is never reimplemented here, only
// called and timed. A thrown exception from any of those is the only thing
// that produces status: 'failed' — "product not found" is a normal,
// succeeded outcome with output.picked === null, same as
// SilpoAgentService.searchAndPickProduct's error-step-but-not-exception
// distinction (src/app/services/silpo-agent.ts).
import Anthropic from '@anthropic-ai/sdk';
import { checkRelevanceWithClient } from '../agent/check-relevance-core';
import { findCartProductByTarget, getCheckoutStatus, type CartState } from '../agent/cart-state';
import { parseItemsWithClient } from '../agent/parse-items-core';
import { selectProduct, type SearchProduct } from '../agent/pick-product';
import { buildSpokenSummary, type AddedItem } from '../agent/spoken-summary';
import { ReauthRequiredError } from '../mcp/oauth';
import {
  addOrUpdateCartProducts,
  findProductsBatch,
  getMyShoppingCart,
  getShoppingCartById,
  removeCartProducts,
  requireCartContext,
  setupCartForAddress,
  type CartSetupResult,
} from '../mcp/silpo-tools';
import type { CartWriteOutput, FinalizeOutput, PlanDecision } from './plan';
import type { LlmUsage, Run, Step, StepKind, ToolCall } from './types';

export interface ExecuteContext {
  sessionId: string;
  // Undefined when ANTHROPIC_API_KEY isn't configured — only 'parse' and
  // 'select_product' need it; they throw (a normal technical failure) if
  // it's missing instead of this being a precondition the caller must check.
  anthropicClient: Anthropic | undefined;
}

async function timed<T>(toolCalls: ToolCall[], name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    toolCalls.push({ name, ok: true, durationMs: Date.now() - start });
    return result;
  } catch (e) {
    toolCalls.push({ name, ok: false, durationMs: Date.now() - start });
    throw e;
  }
}

function computeAttempt(steps: Step[], kind: StepKind, itemKey: string | undefined): number {
  return steps.filter((s) => s.kind === kind && s.itemKey === itemKey).length + 1;
}

async function requireShoppingCartId(toolCalls: ToolCall[], sessionId: string): Promise<string> {
  const mine = await timed(toolCalls, 'getMyShoppingCart', () => getMyShoppingCart(sessionId));
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('No shopping cart yet for this account — it must be created first');
  }
  return mine.shoppingCartId;
}

// Fetched fresh from the MCP server, never taken from a previous step's
// journal output — the journal can be stale, especially across a pause or
// after a crash-recovery retry.
async function fetchCartState(
  toolCalls: ToolCall[],
  sessionId: string,
  shoppingCartId: string,
): Promise<CartState> {
  const fresh = await timed(toolCalls, 'getShoppingCartById', () => getShoppingCartById(sessionId, shoppingCartId));
  // ShoppingCart's declared type under-models the real MCP response (it types
  // shipments[].products loosely, with name/quantity only reachable through
  // its index signature) — the actual payload carries the fields CartState
  // declares, confirmed against live responses (see lib/agent/cart-state.ts
  // and lib/agent/pick-product.ts's SearchProduct for the same gap).
  return { shoppingCartId, cart: fresh.cart, checkoutWebLink: fresh.checkoutWebLink } as unknown as CartState;
}

type Decision = Exclude<PlanDecision, { kind: 'done' }>;

async function runDecision(
  decision: Decision,
  run: Run,
  steps: Step[],
  ctx: ExecuteContext,
  toolCalls: ToolCall[],
  llm: LlmUsage[],
): Promise<unknown> {
  switch (decision.kind) {
    case 'approval':
      // api/runs/[id]/advance.ts intercepts an 'approval' decision before it
      // ever reaches executeStep (it pauses the run instead) — reaching here
      // would mean that guard was bypassed.
      throw new Error('approval decisions must not be executed — handled directly in the advance route');

    case 'setup_cart':
      return timed(toolCalls, 'setupCartForAddress', () => setupCartForAddress(ctx.sessionId, run.input.address));

    case 'parse': {
      if (!ctx.anthropicClient) throw new Error('Query parsing not configured: missing ANTHROPIC_API_KEY');
      const anthropicClient = ctx.anthropicClient;
      return {
        items: await timed(toolCalls, 'parseItemsWithClient', () =>
          parseItemsWithClient(anthropicClient, run.input.request, (usage) => llm.push(usage)),
        ),
      };
    }

    case 'select_product': {
      if (!ctx.anthropicClient) throw new Error('Relevance check not configured: missing ANTHROPIC_API_KEY');
      const anthropicClient = ctx.anthropicClient;
      const { context } = await timed(toolCalls, 'requireCartContext', () => requireCartContext(ctx.sessionId));
      const searchResult = await timed(toolCalls, 'findProductsBatch', () =>
        findProductsBatch(ctx.sessionId, [decision.item.query], context, 5),
      );
      // See fetchCartState's comment — findProductsBatch's declared return
      // type under-models the live response; SearchProduct is the real,
      // confirmed shape (lib/agent/pick-product.ts).
      const candidates = (searchResult.queries[0]?.products ?? []) as unknown as SearchProduct[];

      const outcome = await selectProduct(candidates, decision.item.selector, decision.item.query, (query, candidateName) =>
        timed(toolCalls, 'checkRelevanceWithClient', () =>
          checkRelevanceWithClient(anthropicClient, query, candidateName, (usage) => llm.push(usage)),
        ),
      );

      return {
        picked: outcome.picked,
        reason: outcome.reason,
        detail: outcome.detail,
        candidates,
        anomalyDetected: outcome.anomalyDetected,
      };
    }

    case 'cart_write': {
      const shoppingCartId = await requireShoppingCartId(toolCalls, ctx.sessionId);
      const freshCart = await fetchCartState(toolCalls, ctx.sessionId, shoppingCartId);

      // Idempotent short-circuit — a previous attempt may already have
      // written this exact product/quantity (e.g. the Silpo call succeeded
      // but the process died before appendStep recorded it — see
      // FAULT_INJECTION_SECRET in api/runs/[id]/advance.ts). Retrying would
      // otherwise re-run Silpo calls that already happened, and for a
      // replace specifically it would also wrongly fail on a target that's
      // already gone (handled below).
      const existingPicked = freshCart.cart.shipments
        .flatMap((s) => s.products)
        .find((p) => p.productId === decision.picked.id);

      if (existingPicked && existingPicked.quantity === decision.item.quantity) {
        const itemsInCart = freshCart.cart.shipments.reduce((n, s) => n + s.products.length, 0);
        return {
          shoppingCartId,
          productId: decision.picked.id,
          name: decision.picked.name,
          quantity: decision.item.quantity,
          price: decision.picked.price,
          itemsInCart,
        } satisfies CartWriteOutput;
      }

      if (decision.item.type === 'replace') {
        const existingTarget = findCartProductByTarget(freshCart, decision.item.target);
        if (existingTarget) {
          await timed(toolCalls, 'removeCartProducts', () =>
            removeCartProducts(ctx.sessionId, shoppingCartId, [existingTarget.productId]),
          );
        }
        // else: a prior crashed attempt already removed it — nothing to
        // undo, just proceed to (re-)add the new item below.
      }

      await timed(toolCalls, 'addOrUpdateCartProducts', () =>
        addOrUpdateCartProducts(ctx.sessionId, shoppingCartId, [
          {
            productId: decision.picked.id,
            companyId: decision.picked.companyId,
            branchId: decision.picked.branchId,
            quantity: decision.item.quantity,
            addQuantity: false,
          },
        ]),
      );

      const updated = await fetchCartState(toolCalls, ctx.sessionId, shoppingCartId);
      const itemsInCart = updated.cart.shipments.reduce((n, s) => n + s.products.length, 0);

      return {
        shoppingCartId,
        productId: decision.picked.id,
        name: decision.picked.name,
        quantity: decision.item.quantity,
        price: decision.picked.price,
        itemsInCart,
      } satisfies CartWriteOutput;
    }

    case 'finalize': {
      const shoppingCartId = await requireShoppingCartId(toolCalls, ctx.sessionId);
      const cartState = await fetchCartState(toolCalls, ctx.sessionId, shoppingCartId);
      const checkoutStatus = getCheckoutStatus(cartState);

      const setupStep = steps.find((s) => s.kind === 'setup_cart' && s.status === 'succeeded');
      const hadItemsBefore = setupStep
        ? (setupStep.output as CartSetupResult).cart.shipments.some((s) => (s.products?.length ?? 0) > 0)
        : false;

      const addedItems: AddedItem[] = steps
        .filter((s) => s.kind === 'cart_write' && s.status === 'succeeded')
        .map((s) => {
          const output = s.output as CartWriteOutput;
          return { name: output.name, quantity: output.quantity, price: output.price };
        });

      const spokenSummary = buildSpokenSummary(cartState, addedItems, hadItemsBefore);

      return { cartState, checkoutStatus, spokenSummary } satisfies FinalizeOutput;
    }
  }
}

export async function executeStep(run: Run, steps: Step[], decision: Decision, ctx: ExecuteContext): Promise<Omit<Step, 'index'>> {
  const itemKey = 'itemKey' in decision ? decision.itemKey : undefined;
  const idempotencyKey = decision.kind === 'cart_write' ? `${run.id}:${decision.itemKey}` : undefined;
  const attempt = computeAttempt(steps, decision.kind, itemKey);

  const startedAt = Date.now();
  const toolCalls: ToolCall[] = [];
  const llm: LlmUsage[] = [];

  try {
    const output = await runDecision(decision, run, steps, ctx, toolCalls, llm);
    return {
      runId: run.id,
      kind: decision.kind,
      status: 'succeeded',
      attempt,
      itemKey,
      idempotencyKey,
      input: decision,
      output,
      toolCalls,
      llm: llm.length > 0 ? llm : undefined,
      startedAt,
      finishedAt: Date.now(),
    };
  } catch (e) {
    return {
      runId: run.id,
      kind: decision.kind,
      status: 'failed',
      attempt,
      itemKey,
      idempotencyKey,
      input: decision,
      error: e instanceof Error ? e.message : 'Unknown error',
      errorCode: e instanceof ReauthRequiredError ? 'reauth_required' : undefined,
      toolCalls,
      llm: llm.length > 0 ? llm : undefined,
      startedAt,
      finishedAt: Date.now(),
    };
  }
}
