export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'failed' | 'succeeded' | 'cancelled';

export type StepKind = 'setup_cart' | 'parse' | 'select_product' | 'approval' | 'cart_write' | 'finalize';

export interface ToolCall {
  name: string;
  ok: boolean;
  durationMs: number;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  input: { address: string; request: string };
  currentStep?: StepKind;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// A step is written once, after it finishes — the journal is append-only.
export interface Step {
  runId: string;
  index: number;
  kind: StepKind;
  status: 'succeeded' | 'failed';
  attempt: number;
  itemKey?: string;
  idempotencyKey?: string;
  input: unknown;
  output?: unknown;
  error?: string;
  toolCalls: ToolCall[];
  llm?: LlmUsage[];
  startedAt: number;
  finishedAt: number;
}
