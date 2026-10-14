import { useState } from 'react';
import { RunContext, useApi, useHashPath, useRun } from './api';
import { A } from './ui';
import ModelPage from './pages/ModelPage';
import ReportPage from './pages/ReportPage';
import AssurancePage from './pages/AssurancePage';
import DayPage from './pages/DayPage';
import { ProductPage, TransactionPage } from './pages/DetailPages';
import RunsPage from './pages/RunsPage';

const NAV = [['/model', 'Model', 'model'], ['/report', '60-Day Report', 'report'], ['/assurance', 'Assurance', 'assurance'], ['/day/1', 'Daily Report', 'day'], ['/runs', 'Runs', 'runs']];

function RunLine() {
  const { runId, setRunId } = useRun();
  const { data, error } = useApi(`/runs/${runId}`);
  if (error) return <div className="run error">{error}. Create one with <code>node runSim.js --submit</code>, or use the Runs page.</div>;
  if (!data) return <div className="run">Loading run...</div>;
  const r = data.run;
  return (
    <div className={'run' + (r.is_submitted ? '' : ' warn')}>
      Run <b>{r.run_id}</b> ({r.status}, seed {r.random_seed}) -{' '}
      {r.is_submitted ? <b>Submitted Run</b> : <>not the Submitted Run <button onClick={() => setRunId('current')}>Back to Submitted Run</button></>}
    </div>
  );
}

function Page({ path }) {
  const [section, id] = path.split('/').filter(Boolean);
  switch (section) {
    case 'report': return <ReportPage />;
    case 'assurance': return <AssurancePage />;
    case 'day': return <DayPage day={id || '1'} />;
    case 'product': return <ProductPage id={id} />;
    case 'txn': return <TransactionPage id={id} />;
    case 'runs': return <RunsPage />;
    default: return <ModelPage />;
  }
}

export default function App() {
  const [runId, setRun] = useState(() => sessionStorage.getItem('runId') || 'current');
  const setRunId = (id) => { sessionStorage.setItem('runId', id); setRun(id); };
  const path = useHashPath();
  const section = path.split('/').filter(Boolean)[0] || 'model';
  const on = ['product', 'txn'].includes(section) ? 'report' : section;
  return (
    <RunContext.Provider value={{ runId, setRunId }}>
      <header>
        <b>Autonomous Supermarket</b> <span className="muted">60-day simulation, Swanston St / Town Hall, Melbourne</span>
        <nav>{NAV.map(([to, label, key]) => <span key={key} className={on === key ? 'on' : ''}><A to={to}>{label}</A>{' '}</span>)}</nav>
        <RunLine />
      </header>
      <main key={runId}><Page path={path} /></main>
    </RunContext.Provider>
  );
}
