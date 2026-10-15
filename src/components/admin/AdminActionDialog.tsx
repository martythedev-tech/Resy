import { AlertCircle, CheckCircle2 } from 'lucide-react';

export interface AdminDialogState {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  input?: { label: string; placeholder?: string; type?: string; required?: boolean };
  onConfirm: (value: string) => Promise<boolean | void>;
}

interface AdminActionDialogProps {
  dialog: AdminDialogState;
  value: string;
  loading: boolean;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AdminActionDialog = ({
  dialog,
  value,
  loading,
  onValueChange,
  onCancel,
  onConfirm,
}: AdminActionDialogProps) => (
  <div className="admin-dialog-overlay" role="presentation" onMouseDown={() => !loading && onCancel()}>
    <form
      className="admin-dialog card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-dialog-title"
      onMouseDown={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <div className={`admin-dialog-icon ${dialog.tone || 'primary'}`}>
        {dialog.tone === 'danger' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
      </div>
      <h2 id="admin-dialog-title">{dialog.title}</h2>
      <p>{dialog.description}</p>
      {dialog.input && (
        <div className="admin-dialog-field">
          <label htmlFor="admin-dialog-input">{dialog.input.label}</label>
          {dialog.input.type === 'textarea' || !dialog.input.type ? (
            <textarea
              id="admin-dialog-input"
              className="input"
              rows={3}
              autoFocus
              placeholder={dialog.input.placeholder}
              value={value}
              onChange={event => onValueChange(event.target.value)}
            />
          ) : (
            <input
              id="admin-dialog-input"
              className="input"
              type={dialog.input.type}
              autoFocus
              placeholder={dialog.input.placeholder}
              value={value}
              onChange={event => onValueChange(event.target.value)}
            />
          )}
        </div>
      )}
      <div className="admin-dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>Cancel</button>
        <button type="submit" className={`btn ${dialog.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} disabled={loading}>
          {loading ? 'Working…' : dialog.confirmLabel}
        </button>
      </div>
    </form>
  </div>
);
