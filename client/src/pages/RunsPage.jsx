// Runs: list, switch the run being viewed, create a new run.
import { useState } from 'react';
import { postJson, useApi, useRun } from '../api';
import { Table, money } from '../ui';

export function RunsView({ runs, activeId, onView, onCreate, creating, message }) {
  const [seed, setSeed] = useState('');
  return (
    <>
      <h1>Runs</h1>
      <p className="muted">A run is one complete 60-day history. Its configuration is frozen when it starts and its history is never edited.</p>
      <Table cols={[['Run ID', 'run_id'], ['Status', 'status'], ['Submitted', (r) => (r.is_submitted ? 'Submitted Run' : '')], ['Seed', 'random_seed'], ['Revenue', (r) => (r.revenue ? money(r.revenue) : '-'), 'r'],
        ['', (r) => (r.status !== 'completed' ? '' : r.run_id === activeId ? 'viewing' : <button onClick={() => onView(r.is_submitted ? 'current' : r.run_id)}>View</button>)]]} rows={runs} />
      <h3>Create a new run</h3>
      <p className="muted">Takes a few seconds. It never changes the Submitted Run.</p>
      <label>Seed (optional) <input value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} /></label>{' '}
      <button disabled={creating} onClick={() => onCreate(seed ? Number(seed) : undefined)}>{creating ? 'Simulating...' : 'Create and run'}</button>
      {message && <p className={message.error ? 'error' : ''}>{message.text}</p>}
    </>
  );
}

export default function RunsPage() {
  const { runId, setRunId } = useRun();
  const { data, error, loading, reload } = useApi('/runs');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(null);
  const create = async (seed) => {
    setCreating(true); setMessage(null);
    try { const r = await postJson('/runs', seed ? { seed } : {}); setMessage({ text: `Run ${r.run_id} completed in ${r.seconds.toFixed(1)}s.` }); reload(); }
    catch (e) { setMessage({ text: e.message, error: true }); }
    setCreating(false);
  };
  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading...</p>;
  const activeId = runId === 'current' ? (data.runs.find((r) => r.is_submitted) || {}).run_id : runId;
  return <RunsView runs={data.runs} activeId={activeId} onView={setRunId} onCreate={create} creating={creating} message={message} />;
}
