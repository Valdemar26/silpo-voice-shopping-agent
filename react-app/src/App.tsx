import { useState, type FormEvent } from 'react';
import { useAgentRun } from './useAgentRun';

export default function App() {
  const { run, steps, loading, error, start, advance } = useAgentRun();

  const [address, setAddress] = useState('');
  const [request, setRequest] = useState('');

  console.log('render: ', { address, request });

  const canSubmit = address.trim() !== '' && request.trim() !== '';

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    start(address, request);
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
          <button type="button" onClick={advance} disabled={loading}>
            Advance
          </button>
          <pre>{JSON.stringify(steps, null, 2)}</pre>
        </>
      )}
    </main>
  );

}
