// client/src/api.js - data loading, run selection and hash routing (no extra libraries)
import { createContext, useContext, useEffect, useState } from 'react';

export const RunContext = createContext({ runId: 'current', setRunId: () => {} });
export const useRun = () => useContext(RunContext);

async function request(path, options) {
  const res = await fetch('/api' + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
export const postJson = (path, data) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

// useApi('/runs/current/assurance') -> { data, error, loading, reload }
// Data is tagged with the path it was fetched for, so a page never receives the previous page's data.
export function useApi(path) {
  const [state, setState] = useState({ path: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    request(path)
      .then((data) => alive && setState({ path, data }))
      .catch((e) => alive && setState({ path, error: e.message }));
    return () => { alive = false; };
  }, [path, tick]);
  const fresh = state.path === path;
  return {
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : undefined,
    loading: !fresh,
    reload: () => { setState({ path: null }); setTick((t) => t + 1); },
  };
}

// Hash routing: #/day/7 -> '/day/7'
export function useHashPath() {
  const read = () => (window.location.hash || '#/model').slice(1);
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => { setPath(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}
