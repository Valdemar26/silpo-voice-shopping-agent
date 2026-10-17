# Changelog

Dated entries, newest first. Dates are from `git log`. This project replaced an earlier, unrelated "Financial AI Chat" app on 2026-09-05 — commits before that date belong to the old app and aren't listed here.

## 2026-10-17

- Added resume-after-reload (`GET /api/runs`), retry-with-backoff for transient `advance()` failures, a "Retry" button capped at 3 attempts per step, and an idempotent `cart_write` (checks the live cart before writing, so a retried step can't double-add or fail on an already-removed replace target).
- Added an approval gate: once every item has been searched, the run pauses in `waiting_approval` until the person confirms or drops individual finds, before anything is written to the cart.
- Moved `SilpoAgentService.run()` off direct browser calls to Silpo onto the server-side control plane: the UI now creates a run and calls `advance()` step by step itself, rendering the journal each call returns, instead of talking to Silpo directly.

## 2026-10-16

- Consolidated locking into one Redis-backed module (`lib/redis-lock.ts`, random token + Lua-guarded release/write) and moved the OAuth client-registration and control-plane run locks onto it.
- Serialized token refresh behind a per-session lock so concurrent requests can't both refresh the same refresh token at once.
- `invalid_client`/`invalid_grant` from Silpo's token endpoint now force re-auth (`ReauthRequiredError`, surfaced to the UI) instead of retrying a dead client or refresh token; any other failure (5xx, network) leaves the stored tokens intact.
- Gave the stored tokens key a 90-day TTL (refreshed on every write) so it outlives Silpo's ~30-day access tokens even if a session goes quiet for a while.

## 2026-10-15

- Built the first version of the server-side control plane: `Run`/`Step` types, an append-only journal in Redis (`lib/control-plane/store.ts`), and a `planNext`/`executeStep` orchestrator that advances a run one step per call.
- Fixed a check-then-act race in `POST /api/runs/[id]/advance`: the journal was read before the lock was acquired, so a concurrent call could already have appended a step by the time it ran. Found on review, fixed by re-reading the journal after acquiring the lock.

## 2026-10-06

- Added an English intro block (shown to non-Ukrainian browsers) and an English summary section to the README, plus a screenshot of a run.

## 2026-09-19

- Added 33 eval cases covering query parsing, product selection, and checkout-status logic.
- Replaced the single fixed Redis key for OAuth tokens/MCP session with per-browser-session keys (`lib/mcp/session.ts`), so multiple visitors no longer share one Silpo login.

## 2026-09-18

- Added the eval harness scaffold (`evals/runner.ts`): live Anthropic calls for parsing/relevance against a frozen product-search fixture.

## 2026-09-12

- Removed `api/claude.js`, a leftover unauthenticated proxy to the Anthropic API from the old Financial AI Chat that was still live in production with no caller left in the UI. Added per-IP rate limiting on the LLM/TTS endpoints.

## 2026-09-11

- Updated the project and page title.

## 2026-09-10

- Added a guard against an isolated, outlier-priced top search result (falls back to the cheapest candidate and lists the outlier as an alternative instead of adding it silently).
- Made `getCheckoutStatus` surface the below-minimum and adult-confirmation-required reasons independently, instead of one hiding the other.

## 2026-09-09

- Added an LLM relevance check (`api/agent/check-relevance.ts`, Claude Haiku) after product search, so a textually-matching but wrong-type result (e.g. a "гречка" search returning a candy bar flavored "buckwheat-cherry") gets rejected instead of added.
- Added a dedicated "stock exceeded" checkout state, listing each item whose requested quantity is above what's actually in stock.
- Fixed the TTS summary wrongly appending a second sentence on a genuinely first run, and staggered the step-trace entrance animation so steps appear one at a time instead of all at once.
- Redesigned the result panel as a receipt-style list (monospace prices, paper/kraft palette, product photos restored).

## 2026-09-08

- Forced `addQuantity: false` on cart add/update calls — Silpo's API defaults to adding to the existing quantity rather than setting it (confirmed via Silpo's Discord), which would silently double a repeat add.
- Added automatic refresh of a stale cart timeslot before product search — a long-idle cart could otherwise make every search silently return zero results.
- Added voice-command item replacement ("replace X with Y").
- Added a `SelfPickup` retry for the same address when the `DeliveryHome` branch fails its health check.

## 2026-09-06

- Added voice input (Web Speech API, `uk-UA`, accumulates speech segments until ~3.5s of silence) and voice output (Respeecher TTS) for the run result.
- Added LLM-based parsing of free-text requests into concrete search queries and quantities (Claude, forced tool call) — `find_products_batch` does no NLU of its own.
- Added a checkout button and a "add ₴N more" hint, both driven by a single `getCheckoutStatus` function that checks every error-level cart validation at once.
- Added remove-item (no page reload), share-order (Web Share API or clipboard fallback), a mic-level visualizer, and a geolocation-based address lookup (reverse geocoding via Nominatim, with an explicit warning when the house number can't be resolved).
- Added a progress bar toward the minimum order amount.

## 2026-09-05

- Started the project: MCP OAuth 2.1 + PKCE + Dynamic Client Registration client, product-search and cart wrappers, and a cart-creation flow with explicit errors (ambiguous address, no delivery option, dead branch, cart/address mismatch) instead of silent failures.
- Fixed `callMcpTool` returning the raw JSON-RPC `CallToolResult` instead of the unwrapped business object — every caller was silently getting `undefined`.
- Replaced the old Financial AI Chat UI with a text-only voice-agent skeleton (address + request fields, run button, step trace, result panel).
