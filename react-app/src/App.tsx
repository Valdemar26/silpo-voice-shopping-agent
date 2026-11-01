import { useState, type FormEvent } from 'react';

 export type Run = {
   id: string;
   status: string;
}

export default function App() {
  const [address, setAddress] = useState('');
  const [request, setRequest] = useState('');

  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  console.log('render: ', { address, request });

  const canSubmit = address.trim() !== '' && request.trim() !== '';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, request })
      });

      const data = await res.json();

      if(!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
      setRun(data.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function advanceOnce() {
    if(!run) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${run.id}/advance`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
      setRun(data.run);
      setSteps(data.steps);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Silpo Voice Shopping Agent</h1>

      <form onSubmit={handleSubmit}>
        <input
          placeholder="Delivery address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <textarea
          placeholder="What to buy?"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        ></textarea>
        <button type="submit" disabled={!canSubmit || loading}>
          {loading ? 'Running...' : 'Run!'}
        </button>
      </form>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {run && (
        <>
          <p>Status: {run.status}</p>
          <button type="button" onClick={advanceOnce} disabled={loading}>
            Advance
          </button>
          <pre>{JSON.stringify(steps, null, 2)}</pre>
        </>
      )}
    </main>
  );

}
