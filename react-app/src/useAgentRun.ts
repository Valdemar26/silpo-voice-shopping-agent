import { useEffect, useState, useRef } from 'react';

export type Run = { id: string; status: string };
export type Step = { index: number; kind: string; status: string; error?: string; errorCode?: string };

const MAX_STEPS = 50;
const ACTIVE = ['queued', 'running'];

async function postJson(url: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export function useAgentRun() {
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctrl = new AbortController();

    fetch('/api/runs', { signal: ctrl.signal })
      .then((res) => res.json())
      .then((data) => {
        if (data.run) {
          setRun(data.run);
          setSteps(data.steps ?? []);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(String(err));
      });

    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function call(action: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if(err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function drive(runId: string) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    for (let i = 0; i < MAX_STEPS; i++) {
      const data = await postJson(`/api/runs/${runId}/advance`, undefined, ctrl.signal);
      setRun(data.run);
      setSteps(data.steps);
      if(!ACTIVE.includes(data.run.status)) return;
    }
    setError(`Stopped after ${MAX_STEPS} steps`);
  }

  function start(address: string, request: string) {
    return call(async () => {
      const data = await postJson('/api/runs', { address, request });
      setRun(data.run);
      setSteps([]);
      await drive(data.run.id);
    });
  }

  function stop() {
    abortRef.current?.abort();
  }

  return { run, steps, loading, error, start, stop };
}
