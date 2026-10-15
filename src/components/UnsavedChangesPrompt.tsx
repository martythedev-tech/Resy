import { AlertTriangle } from 'lucide-react';

interface UnsavedChangesPromptProps {
  id: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export const UnsavedChangesPrompt = ({
  id,
  onKeepEditing,
  onDiscard,
}: UnsavedChangesPromptProps) => (
  <div
    className="discard-changes-prompt"
    role="alertdialog"
    aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-description`}
    data-unsaved-changes-prompt
  >
    <div className="discard-changes-heading">
      <span className="discard-changes-icon" aria-hidden="true"><AlertTriangle size={21} /></span>
      <div>
        <h3 id={`${id}-title`}>Discard unsaved changes?</h3>
        <p id={`${id}-description`}>Your reservation details have not been saved.</p>
      </div>
    </div>
    <div className="discard-changes-actions">
      <button type="button" className="btn btn-secondary" onClick={onKeepEditing} autoFocus>
        Keep editing
      </button>
      <button type="button" className="btn btn-danger" onClick={onDiscard}>
        Discard changes
      </button>
    </div>
  </div>
);
