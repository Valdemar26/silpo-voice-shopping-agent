// Cheap LLM sanity check that a found catalog product is actually the type of
// product asked for — not just a text match. Extracted out of
// api/agent/check-relevance.ts so the exact prompt/tool schema/call is
// importable from a plain Node context too, e.g. evals/runner.ts — the edge
// handler there is now a thin HTTP/rate-limit wrapper around
// checkRelevanceWithClient.
import Anthropic from '@anthropic-ai/sdk';

// find_products_batch's own search relevance can be poor — e.g. a search for
// "гречка" (buckwheat) surfacing "Батончик Green Chef Crunch хрумка
// гречка-вишня" (a candy bar whose flavor happens to be named "гречка-вишня")
// as its top hit. A plain substring check ("гречка" in the candidate name)
// would not catch this exact case, since the word genuinely is a substring —
// it's the wrong TYPE of product, not a wrong string match. Hence a real
// (if cheap) semantic check instead.
export const CHECK_RELEVANCE_SYSTEM_PROMPT = `Ти перевіряєш, чи назва товару з каталогу продуктового магазину дійсно є тим ТИПОМ товару, який шукали — а не просто містить схожі слова.

Порівнюй тип товару (крупа, м'ясо, солодощі, напій тощо), а не бренд, смак чи назву-словосполучення. Наприклад:
- Запит "гречка", товар "Батончик Green Chef Crunch хрумка гречка-вишня" — НЕ відповідає: це солодкий батончик зі смаком "гречка-вишня", слово "гречка" тут лише частина назви смаку, а не крупа.
- Запит "гречка", товар "Гречка ядриця Агро" або "Крупа гречана" — відповідає: це реально крупа гречка.
- Запит "рис", товар "Рис Sacramento чорний лущений" — відповідає: це рис.
- Запит "рис", товар "Рисовий пудинг зі смаком карамелі" — сумнівно, якщо це готовий десерт, а не крупа — тоді НЕ відповідає.

Будь консервативним: якщо не впевнений, що це саме той тип товару — краще сказати, що не відповідає.`;

export const CHECK_RELEVANCE_TOOL: Anthropic.Tool = {
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

/**
 * query + a found candidate's name -> whether it's really the same type of
 * product, via the real production system prompt/tool schema (Haiku — a
 * cheap binary check, not the primary parse step). Throws on any malformed
 * model response — callers decide how to surface that (the edge handler
 * returns 502; SilpoAgentService.checkRelevance fails open to `true` instead,
 * since this is a safety net layered on top of the real search, not a hard
 * gate).
 */
export async function checkRelevanceWithClient(
  client: Anthropic,
  query: string,
  candidateName: string,
): Promise<boolean> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: CHECK_RELEVANCE_SYSTEM_PROMPT,
    tools: [CHECK_RELEVANCE_TOOL],
    tool_choice: { type: 'tool', name: 'check_relevance' },
    messages: [
      {
        role: 'user',
        content: `Запит: "${query.trim()}"\nЗнайдений товар: "${candidateName.trim()}"`,
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'check_relevance',
  );
  if (!toolUse) {
    throw new Error('Model did not return the expected tool call');
  }

  const input = toolUse.input as { relevant?: unknown };
  if (typeof input.relevant !== 'boolean') {
    throw new Error('Model returned an invalid relevance result');
  }

  return input.relevant;
}
