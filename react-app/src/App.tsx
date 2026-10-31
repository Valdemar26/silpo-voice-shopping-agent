import { useState, type FormEvent } from 'react';

export default function App() {
  const [address, setAddress] = useState('');
  const [request, setRequest] = useState('');

  console.log('render: ', { address, request });

  const canSubmit = address.trim() !== '' && request.trim() !== '';

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    console.log('submit', { address, request });
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
        <button type="submit" disabled={!canSubmit}>Run!</button>
      </form>
    </main>
  );

}
