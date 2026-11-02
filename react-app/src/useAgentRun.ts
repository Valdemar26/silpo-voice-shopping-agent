import { useEffect, useState } from 'react';

export type Run = { id: string; status: string };
export type Step = { index: number; kind: string; status: string; error?: string; errorCode?: string };

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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

  async function call(action: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function start(address: string, request: string) {
    return call(async () => {
      const data = await postJson('/api/runs', { address, request });
      setRun(data.run);
      setSteps([]);
    });
  }

  function advance() {
    if (!run) return;
    return call(async () => {
      const data = await postJson(`/api/runs/${run.id}/advance`);
      setRun(data.run);
      setSteps(data.steps);
    });
  }

  return { run, steps, loading, error, start, advance };
}
