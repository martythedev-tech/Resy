import { AdminReports } from './admin/AdminReports';
import '../styles/AdminPanel.css';

export const Reports = () => (
  <div className="admin-panel">
    <div className="admin-overview card">
      <div>
        <span className="eyebrow">Insights</span>
        <h1>Reports</h1>
        <p className="subtle">Turn booking history into room, attendance, and technology planning insights.</p>
      </div>
    </div>
    <AdminReports />
  </div>
);
