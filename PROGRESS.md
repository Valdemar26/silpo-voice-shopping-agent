# PROGRESS

Стан на 2026-09-08. Проєкт: голосовий агент замовлення продуктів через MCP Сільпо (`https://mcp.silpo.ua/mcp`). Стек: Angular 21 (фронтенд) + Vercel Edge Functions (TypeScript) + Upstash Redis.

Детальна історія реалізації та фіксів — у `CHANGELOG.md`.

## Що зроблено

- OAuth 2.1 + PKCE + Dynamic Client Registration до `mcp.silpo.ua`, токени лише в Upstash Redis.
- Типізована обгортка над MCP tools пошуку товарів і кошика.
- Флоу створення кошика (адреса → доставка → таймслот → перевірка філії → кошик) з явними типізованими помилками замість мовчазних відмов.
- STT через Web Speech API (кнопка мікрофона, розпізнавання uk-UA, накопичення сегментів мовлення).
- TTS через Respeecher — озвучення фінального результату після виконання.
- LLM-розбір голосового запиту (Claude) на конкретні пошукові запити.
- Розпізнавання кількості товару в LLM-розборі (quantity наскрізно до кошика).
- Новий фронтенд-скелет замість старої фінансової частини застосунку.
- Явна текстова причина неактивності кнопки «Виконати».
- Видалення товару з результату без перезапуску всього флоу.
- Кнопка «Оформити замовлення» з чотирма явними станами готовності кошика (`getCheckoutStatus`).
- Прогрес-бар до мінімальної суми замовлення.
- Кнопка «Поділитися замовленням» (нативний шер або буфер обміну).
- Візуальна індикація активного запису мікрофона (реакція на реальну гучність).
- Кнопка геолокації біля адреси доставки зі зворотним геокодуванням (Nominatim) і попередженням про відсутній номер будинку.
- Форсований `addQuantity: false` на двох рівнях, щоб повторне додавання товару не подвоювало кількість.
- Автоматичне освіження простроченого timeslot перед пошуком товару (`requireCartContext`) — та сама логіка, що вже була в `ensureShoppingCart`.
- Автоматичний retry на `SelfPickup` тієї ж адреси, коли `DeliveryHome`-філія не проходить перевірку живучості (`verifyBranchIsHealthy`) — тільки якщо `get_available_delivery_types` уже дає прямий `branchId` для `SelfPickup`; інакше (чи якщо `SelfPickup` теж «мертвий») кидається `DeadBranchError`, як і раніше. Кожна спроба й причина переходу видно в `trace`.
- Заміна товару голосовою командою («замініть кеш'ю на щось без солі», «заміни хліб на цільнозерновий»): LLM-розбір (`api/agent/parse-items.ts`) додатково повертає `{type: "replace", target, query, quantity}` поруч зі звичайним `{type: "add", ...}`; `SilpoAgentService.replaceProductInCart` знаходить `target` у поточному кошику (найпростіший substring/word-overlap збіг, без fuzzy-логіки), видаляє й додає новий товар за `query`, з окремим trace-кроком і явною помилкою, якщо target не знайдено в кошику чи новий товар не знайдено пошуком.
- Критерій вибору «по акції»/«зі знижкою»/«найдешевше» серед знайдених товарів більше не відкидається при розборі: LLM (`api/agent/parse-items.ts`) повертає окреме поле `selector: "discount"` поряд зі звичайним `query`; `SilpoAgentService.searchAndPickProduct` обирає серед кандидатів товар, що реально на знижці (`oldPrice`/`specialPrices` з `silpo_find_products_batch`), інакше бере перший, як і раніше, але явно позначає в trace, що критерій не задоволено.

Все підтверджено живими прогонами на проді (`https://silpo-voice-shopping-agent.vercel.app`) з реальним акаунтом Сільпо.

## Архітектура коротко

```
Angular UI (src/app) ──fetch──> api/mcp/*.ts (Vercel Edge)
                                      │
                        lib/mcp/{oauth,client,silpo-tools}.ts
                                      │
                              mcp.silpo.ua/mcp (JSON-RPC / Streamable HTTP)

Upstash Redis: mcp:client, mcp:tokens:default, mcp:session_id, mcp:oauth:state:<state>
```

Проєкт живе на GitHub `Valdemar26/silpo-voice-shopping-agent` (гілка `main`), Vercel-проєкт `silpo-voice-shopping-agent` (правильно прив'язаний у `.vercel/project.json`). Env vars (`UPSTASH_REDIS_REST_URL/TOKEN`, `APP_BASE_URL`, `ANTHROPIC_API_KEY`, `RESPEECHER_API_KEY`, `RESPEECHER_VOICE_ID`) сконфігуровані в Vercel Production.

## Що лишилось

- Критерій «найдешевше» наразі евристично мапиться на той самий `selector: "discount"` (немає окремого сортування кандидатів за ціною) — товар, що просто дешевший за інших, але формально не на знижці (нема `oldPrice`/`specialPrices`), спеціально обраний не буде. Критерії, не повʼязані з ціною/знижкою (наприклад «щоб було свіже», «органічне»), як і раніше повністю відкидаються при розборі.
- `DeadBranchError` на `DeliveryHome` тепер має один рівень retry: `setupCartForAddress` пробує `SelfPickup` для тієї ж адреси, якщо в `get_available_delivery_types` для неї вже є прямий `branchId`. Якщо такого варіанту нема (потрібен `list_branches`) або він теж «мертвий» — падає з помилкою, як і раніше.
- Створення кошика напряму підтримує тільки `DeliveryHome` і (як fallback вище) `SelfPickup` із прямим `branchId`; NovaPoshta та SelfPickup без прямого `branchId` (де потрібен `list_branches`, щоб знайти найближчу філію) не реалізовано.

## На що звернути увагу

- **Vite-проксі**: Angular 21 dev-server на Vite, `proxy.conf.json` має бути `"/api"` (bare prefix), НЕ `"/api/*"` — glob-синтаксис зі старого webpack-proxy тут мовчки нічого не матчить.
- **`create_shopping_cart` ідемпотентний і мовчить**: якщо кошик уже є, він повертає його як є, ігноруючи нові адресу/branch/timeslot. `ensureShoppingCart` тому завжди звіряє адресу (кидає помилку при розбіжності) і окремо чинить лише таймслот.
- **MCP-відповіді треба розпаковувати**: `payload.result` з `tools/call` — це `CallToolResult`, не бізнес-обʼєкт. Дивись `unwrapToolResult` у `lib/mcp/client.ts`, якщо додаєш нові виклики напряму (в обхід `callMcpTool` — так робити не варто).
- Single-user допущення пронизує весь бекенд (`mcp:tokens:default` — фіксований ключ). Перед мультикористувацьким релізом треба переробити на per-session/per-user ключі й cookie.
- `verifyBranchIsHealthy` — евристика (пошук «молоко», перевірка `stock≠0`), не гарантія; не перевіряли на інших регіонах/філіях крім Львова.
- **Прострочений timeslot і пошук товарів — виправлено**: `silpo_find_products_batch` мовчки повертав 0 результатів для будь-якого запиту, якщо кошик довго простояв і його `validations` містили error-level `timeslot`. `requireCartContext` (`lib/mcp/silpo-tools.ts`) тепер сам перевіряє це й освіжає timeslot тим самим шляхом, що й `ensureShoppingCart` (`silpo_update_shopping_cart` + новий доступний слот), перш ніж віддати контекст для пошуку — вручну повторювати `POST /api/mcp/cart/create` більше не потрібно. Якщо все одно щось не знаходиться — це вже інша причина.
