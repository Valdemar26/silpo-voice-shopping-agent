export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../lib/mcp/http';

interface ParseItemsBody {
  text?: unknown;
}

const SYSTEM_PROMPT = `Ти розбираєш вільну українську фразу з голосового замовлення продуктів на список конкретних пошукових запитів для каталогу продуктового магазину.

Правила:
- Кожен запит — 1-2 слова, іменник(и) у називному відмінку, як його шукали б у пошуку магазину ("молоко", "чорний хліб").
- Розпливчасті категорії ("смаколики", "щось солодке", "якісь фрукти") заміни ОДНИМ конкретним товаром-кандидатом на свій розсуд (наприклад "смаколики" → "цукерки"). Ніколи не проси уточнення й не залишай запит розпливчастим.
- Критерії вибору серед знайдених товарів (наприклад "по акції", "найдешевше", "щоб було свіже") — це НЕ окремий товар, пропускай їх повністю.
- Слова ввічливості, вставні конструкції ("я б хотів", "можливо", "також") ігноруй.
- Якщо у фразі взагалі немає жодного товару — поверни порожній список.
- Не вигадуй товари, яких немає у фразі, окрім конкретизації розпливчастих категорій вище.`;

const extractTool: Anthropic.Tool = {
  name: 'extract_search_queries',
  description: 'Зберігає розібраний список конкретних пошукових запитів товарів.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Конкретні одно-двослівні пошукові запити товарів українською, без критеріїв вибору.',
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
    if (!Array.isArray(input.items) || !input.items.every((i) => typeof i === 'string')) {
      return json({ error: 'Model returned an invalid items list' }, 502);
    }

    const items = input.items.map((i) => i.trim()).filter((i) => i.length > 0);
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
