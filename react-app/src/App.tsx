import { useState, type FormEvent } from 'react';
import { useAgentRun } from './useAgentRun';
import { StepList } from './StepList';

export default function App() {
  const { run, steps, loading, error, start, stop } = useAgentRun();

  const [address, setAddress] = useState('');
  const [request, setRequest] = useState('');

  console.log('render: ', { address, request });

  const canSubmit = address.trim() !== '' && request.trim() !== '';
  const needsLogin = steps.some((s) => s.errorCode === 'reauth_required');

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
          <button type="button" onClick={stop} disabled={loading}>
            Stop
          </button>
          {needsLogin && (
            <p>
              <a href="/api/mcp/auth/login">Увійти через Сільпо</a>
            </p>
          )}
          <StepList steps={steps} />
        </>
      )}
    </main>
  );

}
