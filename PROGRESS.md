# PROGRESS

Стан на 2026-09-05. Проєкт: голосовий агент замовлення продуктів через MCP Сільпо (`https://mcp.silpo.ua/mcp`). Стек: Angular 21 (фронтенд) + Vercel Edge Functions (TypeScript) + Upstash Redis.

## Що зроблено

**OAuth 2.1 + PKCE (S256) + Dynamic Client Registration** до `mcp.silpo.ua`
- `lib/mcp/pkce.ts`, `oauth.ts`, `redis.ts`, `client.ts`
- `api/mcp/auth/{register,login,callback}.ts`
- Токени й client credentials лише в Upstash Redis (`mcp:client`, `mcp:tokens:default`), ніколи на клієнті. Single-user проєкт — фіксований ключ, без per-session cookie.
- Refresh токена, MCP-сесія (`Mcp-Session-Id`) з автоматичним re-init при 400/404.

**Пошук товарів і кошик**
- `lib/mcp/silpo-tools.ts` — типізована обгортка над реальними Сільпо MCP tools.
- `api/mcp/products/search.ts`, `api/mcp/cart/{index,items,clear}.ts`.

**Флоу створення кошика** (`api/mcp/cart/create.ts` → `setupCartForAddress`)
`find_address → get_available_delivery_types → get_time_slots → контрольний find_products_batch → create_shopping_cart`, з явними типізованими відмовами замість мовчазних рішень:
- `AddressAmbiguousError` (>1 адреса від find_address)
- `NoDeliveryOptionError` (немає DeliveryHome з прямим branchId)
- `DeadBranchError` (контрольний пошук «молоко» повернув 0 результатів або 0 в наявності — філія «вироджена»)
- `CartAddressMismatchError` — **окрема** перевірка, незалежна від таймслота: `create_shopping_cart` ідемпотентний і може мовчки повернути чужий/старий кошик; адреса порівнюється нормалізовано (case+дефіси), щоб не плутати форматування зі справжньою розбіжністю
- Кожен виклик повертає `trace: {step, detail}[]` для UI/дебагу

**Критичний фікс**: `callMcpTool` спочатку повертав сирий JSON-RPC `CallToolResult` (`{content:[{type:'text',text}], structuredContent}`) замість розпакованого бізнес-обʼєкта — усі функції мовчки отримували `undefined`. Виправлено в `lib/mcp/client.ts` (`unwrapToolResult`).

**Фронтенд-скелет** (`src/app/`)
Стару фінансову частину (Excel/PDF, Claude-чат, дашборд, chart/table) видалено повністю разом з невикористаними залежностями (`xlsx`, `chart.js`, `partial-json`, `@anthropic-ai/sdk`).
Новий UI: адреса + текстове поле «що потрібно» (тимчасова заміна голосу) → кнопка «Виконати» → індикатор кроків (включно з trace від `setupCartForAddress`) → блок результату (товари, суми, validations, посилання на checkout — поки завжди «недоступне», бо такого поля/тула ще немає).
`SilpoAgentService` (`src/app/services/silpo-agent.ts`) — вся оркестрація й стан на сигналах, без HttpClient (прямий `fetch`, як і решта проєкту).

Все підтверджено **живими** викликами на проді (`https://silpo-voice-shopping-agent.vercel.app`), включно з реальним акаунтом Сільпо: реєстрація клієнта, логін, створення кошика за адресою «Львів, Малоголосківська, 8є», додавання/видалення товару, повний UI-прогін у браузері.

## Архітектура коротко

```
Angular UI (src/app) ──fetch──> api/mcp/*.ts (Vercel Edge)
                                      │
                        lib/mcp/{oauth,client,silpo-tools}.ts
                                      │
                              mcp.silpo.ua/mcp (JSON-RPC / Streamable HTTP)

Upstash Redis: mcp:client, mcp:tokens:default, mcp:session_id, mcp:oauth:state:<state>
```

Проєкт живе на GitHub `Valdemar26/silpo-voice-shopping-agent` (гілка `main`), Vercel-проєкт `silpo-voice-shopping-agent` (правильно прив'язаний у `.vercel/project.json`). Env vars (`UPSTASH_REDIS_REST_URL/TOKEN`, `APP_BASE_URL`, `ANTHROPIC_API_KEY`) сконфігуровані в Vercel Production.

## Що лишилось

- **STT** (розпізнавання мови) — не починали.
- **TTS через Respeecher** — не починали.
- Реальна LLM-оркестрація «що потрібно» → tool calls (зараз — наївний спліт по комах/«і»/«та», без розуміння кількості, заміни, уточнень).
- Checkout / оформлення замовлення — жодного tool під це не досліджували; поле `checkoutWebLink` у UI — заглушка на майбутнє.
- Обробка `DeadBranchError` (мертва філія) — зараз лише падає з помилкою, нема автоматичного retry на іншу філію чи SelfPickup/NovaPoshta.
- Створення кошика підтримує тільки `DeliveryHome` (є прямий `branchId`); SelfPickup/NovaPoshta (де `branchId=null`, потрібен `list_branches`) не реалізовано.

## На що звернути увагу

- **Vite-проксі**: Angular 21 dev-server на Vite, `proxy.conf.json` має бути `"/api"` (bare prefix), НЕ `"/api/*"` — glob-синтаксис зі старого webpack-proxy тут мовчки нічого не матчить.
- **`create_shopping_cart` ідемпотентний і мовчить**: якщо кошик уже є, він повертає його як є, ігноруючи нові адресу/branch/timeslot. `ensureShoppingCart` тому завжди звіряє адресу (кидає помилку при розбіжності) і окремо чинить лише таймслот.
- **MCP-відповіді треба розпаковувати**: `payload.result` з `tools/call` — це `CallToolResult`, не бізнес-обʼєкт. Дивись `unwrapToolResult` у `lib/mcp/client.ts`, якщо додаєш нові виклики напряму (в обхід `callMcpTool` — так робити не варто).
- Single-user допущення пронизує весь бекенд (`mcp:tokens:default` — фіксований ключ). Перед мультикористувацьким релізом треба переробити на per-session/per-user ключі й cookie.
- `verifyBranchIsHealthy` — евристика (пошук «молоко», перевірка `stock≠0`), не гарантія; не перевіряли на інших регіонах/філіях крім Львова.
