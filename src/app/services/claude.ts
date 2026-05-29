import { Injectable } from '@angular/core';
import { parse, Allow } from 'partial-json';
import { ChartData } from '../components/chart/chart';
import { UploadedFile } from './excel-parser';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TableData {
  columns: string[];
  rows: any[][];
}

export interface CacheStats {
  cacheRead: number;
  cacheWritten: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClaudeResponse {
  answer: string;
  chart?: ChartData;
  table?: TableData;
  cacheStats?: CacheStats;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onDone: (result: ClaudeResponse) => void;
  onError: (error: string) => void;
}

const TOOLS = [
  {
    name: 'answer_question',
    description: 'Return a plain text answer to the user question',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'render_chart',
    description: 'Render a chart when user asks for visualization, graph, or chart',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'doughnut', 'pie', 'line'] },
        title: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        datasets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              data: { type: 'array', items: { type: 'number' } }
            }
          }
        },
        summary: { type: 'string' }
      },
      required: ['type', 'title', 'labels', 'datasets', 'summary']
    }
  },
  {
    name: 'render_table',
    description: 'Render a data table when user asks for a list, top-N, or comparison',
    input_schema: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
        summary: { type: 'string' }
      },
      required: ['columns', 'rows', 'summary']
    }
  }
];

@Injectable({ providedIn: 'root' })
export class ClaudeService {
  private readonly API_URL = '/api/claude';
  private systemPrompt = '';

  setDataContext(context: string): void {
    this.systemPrompt = `You are a financial data analyst. Analyze the data below and answer questions accurately.

  The user has uploaded one or more files. Each file is marked with "=== FILE: filename ===".
  When relevant, treat them as related data sources — for example, financial data and location data may correlate. Mention which file the answer comes from when it adds clarity.

  ${context}

  Always call exactly one tool per response:
  - answer_question → for text answers
  - render_chart → when user asks for chart/graph/visualization
  - render_table → when user asks for list, top-N, ranking, or comparison table`;
  }

  async chatStream(
    history: ChatMessage[], 
    pdfs: UploadedFile[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {

    // Build messages array, prepending PDFs to the LATEST user message
    const messages = history.map((msg, idx) => {
      const isLatestUserMessage = idx === history.length - 1 && msg.role === 'user';

      if (isLatestUserMessage && pdfs.length > 0) {
        return {
          role: 'user',
          content: [
            ...pdfs.map(pdf => ({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.base64
              },
              cache_control: { type: 'ephemeral' }
            })),
            { type: 'text', text: msg.content }
          ]
        };
      }

      return msg;
    });

    let response: Response;

    try {
      response = await fetch(this.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          stream: true,
          system: [
            {
              type: 'text',
              text: this.systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ],
          tools: TOOLS,
          tool_choice: { type: 'any' },
          messages
        }),
        signal
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        callbacks.onError('⏹ Generation stopped');
        return;
      }
      callbacks.onError(`Network error: ${e?.message ?? e}`);
      return;
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        const message = body?.error?.message ?? '';
        if (message.toLowerCase().includes('credit balance')) {
          errorMsg = '💳 API credits exhausted. Please add credits at console.anthropic.com';
        } else if (response.status === 429) {
          errorMsg = '⏱ Rate limit hit. Please wait a moment and try again.';
        } else if (message) {
          errorMsg = message;
        }
      } catch {}
      callbacks.onError(errorMsg);
      return;
    }

    let currentToolName = '';
    let accumulatedJson = '';
    let lastStreamedText = '';
    let cacheStats: CacheStats | undefined;

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events розділяються через \n\n
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // останній може бути неповний

        for (const eventBlock of events) {
          const dataLine = eventBlock.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;

          const dataStr = dataLine.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          let event: any;
          try { event = JSON.parse(dataStr); } catch { continue; }

          if (event.type === 'message_start') {
            const usage = event.message?.usage;
            if (usage) {
              cacheStats = {
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheWritten: usage.cache_creation_input_tokens ?? 0,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: 0
              };
            }
            continue;
          }

          if (event.type === 'message_delta') {
            const outputTokens = event.usage?.output_tokens;
            if (outputTokens && cacheStats) {
              cacheStats.outputTokens = outputTokens;
            }
            continue;
          }

          if (event.type === 'content_block_start') {
            currentToolName = event.content_block?.name ?? '';
            accumulatedJson = '';
            lastStreamedText = '';
            continue;
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            accumulatedJson += event.delta.partial_json ?? '';
            continue;
          }

          if (event.type === 'content_block_stop' && accumulatedJson) {
            try {
              const input = JSON.parse(accumulatedJson);
              const result = this.buildResult(currentToolName, input);
              callbacks.onDone({ ...result, cacheStats });
            } catch (e) {
              callbacks.onError('Failed to parse tool response');
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        callbacks.onError('⏹ Generation stopped');
        return;
      }
      callbacks.onError(`Stream error: ${e?.message ?? e}`);
    }
  }

  private buildResult(toolName: string, input: any): ClaudeResponse {
    if (toolName === 'render_chart') {
      return {
        answer: input.summary ?? '',
        chart: {
          type: input.type,
          title: input.title,
          labels: input.labels,
          datasets: input.datasets
        }
      };
    }
    if (toolName === 'render_table') {
      return {
        answer: input.summary ?? '',
        table: {
          columns: input.columns,
          rows: input.rows
        }
      };
    }
    return { answer: input.text ?? '' };
  }
}
