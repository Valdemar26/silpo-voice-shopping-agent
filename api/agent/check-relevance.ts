export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../lib/mcp/http';
import { checkRateLimit } from '../../lib/rate-limit';

interface CheckRelevanceBody {
  query?: unknown;
  candidateName?: unknown;
}

// find_products_batch's own search relevance can be poor — e.g. a search for
// "гречка" (buckwheat) surfacing "Батончик Green Chef Crunch хрумка
// гречка-вишня" (a candy bar whose flavor happens to be named "гречка-вишня")
// as its top hit. A plain substring check ("гречка" in the candidate name)
// would not catch this exact case, since the word genuinely is a substring —
// it's the wrong TYPE of product, not a wrong string match. Hence a real
// (if cheap) semantic check instead.
const SYSTEM_PROMPT = `Ти перевіряєш, чи назва товару з каталогу продуктового магазину дійсно є тим ТИПОМ товару, який шукали — а не просто містить схожі слова.

Порівнюй тип товару (крупа, м'ясо, солодощі, напій тощо), а не бренд, смак чи назву-словосполучення. Наприклад:
- Запит "гречка", товар "Батончик Green Chef Crunch хрумка гречка-вишня" — НЕ відповідає: це солодкий батончик зі смаком "гречка-вишня", слово "гречка" тут лише частина назви смаку, а не крупа.
- Запит "гречка", товар "Гречка ядриця Агро" або "Крупа гречана" — відповідає: це реально крупа гречка.
- Запит "рис", товар "Рис Sacramento чорний лущений" — відповідає: це рис.
- Запит "рис", товар "Рисовий пудинг зі смаком карамелі" — сумнівно, якщо це готовий десерт, а не крупа — тоді НЕ відповідає.

Будь консервативним: якщо не впевнений, що це саме той тип товару — краще сказати, що не відповідає.`;

const relevanceTool: Anthropic.Tool = {
  name: 'check_relevance',
  description: 'Зберігає результат перевірки: чи назва товару дійсно відповідає типу товару з пошукового запиту.',
  input_schema: {
    type: 'object',
    properties: {
      relevant: {
        type: 'boolean',
        description:
          'true — товар дійсно того типу, який шукали. false — інший тип товару, навіть якщо слово з запиту текстово збігається (напр. лише частина назви смаку/бренду).',
      },
    },
    required: ['relevant'],
  },
};

// Server-side only: keeps ANTHROPIC_API_KEY off the client, same pattern as
// api/agent/parse-items.ts.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Shares the 'agent' counter with parse-items.ts — see comment there.
  const rateLimit = await checkRateLimit(req, 'agent', 30);
  if (!rateLimit.allowed) {
    return json({ error: 'Забагато запитів — спробуйте за хвилину' }, 429);
  }

  let body: CheckRelevanceBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return json({ error: 'query must be a non-empty string' }, 400);
  }
  if (typeof body.candidateName !== 'string' || body.candidateName.trim().length === 0) {
    return json({ error: 'candidateName must be a non-empty string' }, 400);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return json({ error: 'Relevance check not configured: missing ANTHROPIC_API_KEY' }, 503);
  }

  try {
    const client = new Anthropic({ apiKey });

    // Haiku, not Opus — this is a cheap binary sanity check on top of the
    // real search, run once per item added, not the primary parse step.
    // Haiku doesn't support output_config.effort (confirmed: 400 "This model
    // does not support the effort parameter" — unlike claude-opus-5 in
    // parse-items.ts), so it's omitted here.
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      tools: [relevanceTool],
      tool_choice: { type: 'tool', name: 'check_relevance' },
      messages: [
        {
          role: 'user',
          content: `Запит: "${body.query.trim()}"\nЗнайдений товар: "${body.candidateName.trim()}"`,
        },
      ],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'check_relevance',
    );
    if (!toolUse) {
      return json({ error: 'Model did not return the expected tool call' }, 502);
    }

    const input = toolUse.input as { relevant?: unknown };
    if (typeof input.relevant !== 'boolean') {
      return json({ error: 'Model returned an invalid relevance result' }, 502);
    }

    return json({ relevant: input.relevant }, 200);
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
