import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { setToken } from './api';
import { ROLE_LABEL } from './components/ui';
import { Admin } from './pages/Admin';
import { Assistant } from './pages/Assistant';
import { AuditView } from './pages/AuditView';
import { CapacityView } from './pages/CapacityView';
import { DailyControl } from './pages/DailyControl';
import { GanttView } from './pages/GanttView';
import { Login } from './pages/Login';
import { PriorityView } from './pages/PriorityView';
import { ProjectDetails } from './pages/ProjectDetails';
import { ScenariosView } from './pages/ScenariosView';
import { AppProvider, useApp } from './store';
import { getToken } from './api';

function Shell() {
  const { user, connected, presence, can } = useApp();
  if (!getToken()) return <Login />;
  if (!user) return <div className="pad muted">Loading…</div>;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><span className="logo">⚡</span> EV Production Planner</div>
        <nav>
          <NavLink to="/daily">Daily Control</NavLink>
          <NavLink to="/priority">Priority</NavLink>
          <NavLink to="/gantt">Gantt</NavLink>
          <NavLink to="/capacity">Program & Capacity</NavLink>
          <NavLink to="/scenarios">Scenarios</NavLink>
          <NavLink to="/assistant">AI Assistant</NavLink>
          <NavLink to="/audit">Audit</NavLink>
          {can('admin.config') && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="spacer" />
        <span className={`live ${connected ? 'on' : ''}`} title={connected ? `Live — ${presence.length} user(s) connected` : 'Reconnecting…'}>● {connected ? `live · ${presence.length}` : 'offline'}</span>
        <span className="me">{user.name} <span className="role">{ROLE_LABEL[user.role]}</span></span>
        <button className="secondary small" onClick={() => { setToken(null); location.href = '/'; }}>Sign out</button>
      </header>
      <main>
        <Routes>
          <Route path="/daily" element={<DailyControl />} />
          <Route path="/priority" element={<PriorityView />} />
          <Route path="/gantt" element={<GanttView />} />
          <Route path="/projects/:id" element={<ProjectDetails />} />
          <Route path="/capacity" element={<CapacityView />} />
          <Route path="/scenarios" element={<ScenariosView />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/audit" element={<AuditView />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to={user.role === 'MANAGEMENT' ? '/daily' : '/priority'} />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter><Shell /></BrowserRouter>
    </AppProvider>
  );
}
