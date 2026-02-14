import type { RefObject } from "react";

interface SaveNameModalProps {
  show: boolean;
  title: string;
  inputId: string;
  label: string;
  value: string;
  inputRef?: RefObject<HTMLInputElement>;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export function SaveNameModal({
  show,
  title,
  inputId,
  label,
  value,
  inputRef,
  onChange,
  onClose,
  onSave,
}: SaveNameModalProps) {
  if (!show) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{title}</h3>
        <div className="form-group">
          <label htmlFor={inputId}>{label}</label>
          <input
            id={inputId}
            type="text"
            value={value}
            ref={inputRef}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onSave()}
          />
        </div>
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">Cancel</button>
          <button className="button save-button" onClick={onSave} type="button">Save</button>
        </div>
      </div>
    </div>
  );
}
