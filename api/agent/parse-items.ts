export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../lib/mcp/http';
import { checkRateLimit } from '../../lib/rate-limit';

interface ParseItemsBody {
  text?: unknown;
}

// The only selection criterion implemented on the backend so far — see
// SilpoAgentService.searchAndPickProduct. Other criteria mentioned in speech
// ("найдешевше", "щоб було свіже") are still dropped at parse time until
// their own selection logic exists.
type Selector = 'discount';

interface AddItem {
  type: 'add';
  query: string;
  quantity: number;
  selector?: Selector;
}

interface ReplaceItem {
  type: 'replace';
  target: string;
  query: string;
  quantity: number;
  selector?: Selector;
}

type ParsedItem = AddItem | ReplaceItem;

function isParsedItem(item: unknown): item is ParsedItem {
  if (typeof item !== 'object' || item === null) return false;
  const i = item as Record<string, unknown>;
  if (typeof i['query'] !== 'string' || typeof i['quantity'] !== 'number') return false;
  if (i['type'] !== 'add' && i['type'] !== 'replace') return false;
  if (i['type'] === 'replace' && typeof i['target'] !== 'string') return false;
  if (i['selector'] !== undefined && i['selector'] !== 'discount') return false;
  return true;
}

const SYSTEM_PROMPT = `Ти розбираєш вільну українську фразу з голосового замовлення продуктів на список конкретних дій для каталогу продуктового магазину: додати товар або замінити вже наявний у кошику товар на інший.

Правила для звичайного додавання (type: "add"):
- Кожен запит (query) — 1-2 слова, іменник(и) у називному відмінку, як його шукали б у пошуку магазину ("молоко", "чорний хліб").
- Розпливчасті категорії ("смаколики", "щось солодке", "якісь фрукти") заміни ОДНИМ конкретним товаром-кандидатом на свій розсуд (наприклад "смаколики" → "цукерки"). Ніколи не проси уточнення й не залишай запит розпливчастим.
- Критерії вибору серед знайдених товарів (наприклад "по акції", "найдешевше", "зі знижкою") — це НЕ окремий товар і не мають потрапляти в query. Постав їх окремим полем selector (див. "Спільне" нижче).
- Слова ввічливості, вставні конструкції ("я б хотів", "можливо", "також") ігноруй.
- Не вигадуй товари, яких немає у фразі, окрім конкретизації розпливчастих категорій вище.

Правила для заміни товару (type: "replace"):
- Спрацьовує лише коли фраза явно каже замінити щось, вже наявне в кошику, на інше — ключові конструкції "замініть X на Y", "заміни X на Y", "замість X — Y", "X поміняй на Y". Просте побажання щодо нового товару (навіть із "без солі"/"без глютену") без дієслова заміни — це звичайне "add", а не "replace".
- target — коротка назва чи опис товару, який треба знайти й прибрати з ПОТОЧНОГО кошика (те, що йде після "замініть"/"замість" і до "на"), стільки слів, скільки треба, щоб однозначно впізнати його серед уже доданих товарів. Не вигадуй target, якого немає у фразі.
- query — конкретний 1-3-слівний пошуковий запит нового товару замість target, за тими ж правилами, що й для "add" (можеш конкретизувати розпливчасте побажання, наприклад "щось без солі" при заміні горіхів → "горішки без солі"), критерії вибору так само йдуть у selector, а не в query.

Спільне:
- Критерій вибору серед знайдених товарів: якщо фраза явно каже "по акції", "зі знижкою", "найдешевше" чи схоже — постав selector: "discount" (це єдине значення, яке зараз підтримується). Критерії не про ціну/знижку (наприклад "щоб було свіже", "органічне") не підтримуються — просто не заповнюй selector, як і коли критерію взагалі нема.
- Якщо у фразі взагалі немає жодного товару чи заміни — поверни порожній список.
- Кількість (quantity): якщо в мовленні явно названо число ("два літри молока", "три яйця", "5 йогуртів") — постав саме це число. Якщо кількість не згадана взагалі, або згадана лише як означений артикль/тара без числа ("пляшку пива", "буханку хліба", "пачку цукерок") — quantity = 1. Ніколи не вигадуй число, якого не було сказано.`;

const extractTool: Anthropic.Tool = {
  name: 'extract_search_queries',
  description: 'Зберігає розібраний список дій над кошиком: додавання нового товару або заміну наявного.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['add', 'replace'],
              description:
                '"add" — просто додати query в кошик. "replace" — прибрати з кошика товар, що відповідає target, і додати query замість нього; лише коли фраза явно каже замінити.',
            },
            target: {
              type: 'string',
              description:
                'Лише для type="replace": назва/опис товару, який треба знайти в поточному кошику і прибрати. Не заповнюй для type="add".',
            },
            query: {
              type: 'string',
              description: 'Конкретний одно-двослівний пошуковий запит товару українською, без критеріїв вибору.',
            },
            quantity: {
              type: 'integer',
              description:
                'Кількість, якщо явно названа числом у мовленні; інакше 1. Ніколи не вигадуй число, якого не було сказано.',
            },
            selector: {
              type: 'string',
              enum: ['discount'],
              description:
                'Критерій вибору серед знайдених товарів, лише якщо він явно згаданий у фразі: "discount" — товар по акції/зі знижкою/найдешевший. Не заповнюй, якщо критерію нема або він не про ціну/знижку.',
            },
          },
          required: ['type', 'query', 'quantity'],
        },
        description: 'Список дій над кошиком із кількістю.',
      },
    },
    required: ['items'],
  },
};

// Server-side only: keeps ANTHROPIC_API_KEY off the client, same pattern as
// api/tts/speak.ts for the Respeecher key.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Every request here is a paid Anthropic call — cap it per IP before doing
  // anything else. Shares the same 'agent' counter as check-relevance.ts
  // (one Redis key per IP for both endpoints combined), since both draw on
  // the same "how many Anthropic calls is this IP allowed per minute" budget.
  const rateLimit = await checkRateLimit(req, 'agent', 30);
  if (!rateLimit.allowed) {
    return json({ error: 'Забагато запитів — спробуйте за хвилину' }, 429);
  }

  let body: ParseItemsBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return json({ error: 'text must be a non-empty string' }, 400);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return json({ error: 'Query parsing not configured: missing ANTHROPIC_API_KEY' }, 503);
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      tools: [extractTool],
      tool_choice: { type: 'tool', name: 'extract_search_queries' },
      messages: [{ role: 'user', content: body.text }],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'extract_search_queries',
    );
    if (!toolUse) {
      return json({ error: 'Model did not return the expected tool call' }, 502);
    }

    const input = toolUse.input as { items?: unknown };
    if (!Array.isArray(input.items) || !input.items.every(isParsedItem)) {
      return json({ error: 'Model returned an invalid items list' }, 502);
    }

    const items: ParsedItem[] = input.items
      .map((i): ParsedItem | null => {
        const query = i.query.trim();
        const quantity = Math.max(1, Math.round(i.quantity));
        if (query.length === 0) return null;
        const selector = i.selector;

        if (i.type === 'replace') {
          const target = i.target.trim();
          if (target.length === 0) return null;
          return { type: 'replace', target, query, quantity, selector };
        }
        return { type: 'add', query, quantity, selector };
      })
      .filter((i): i is ParsedItem => i !== null);
    return json({ items }, 200);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return json({ error: 'Invalid Anthropic API key' }, 502);
    }
    if (e instanceof Anthropic.RateLimitError) {
      return json({ error: 'Anthropic rate limit exceeded' }, 502);
    }
    if (e instanceof Anthropic.APIError) {
      return json({ error: `Anthropic API error: ${e.message}` }, 502);
    }
    return errorResponse(e);
  }
}
