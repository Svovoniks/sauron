import { useState } from "react";
import { Modal } from "./Modal";

interface SaveNameModalProps {
  title: string;
  inputId: string;
  label: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

export function SaveNameModal({ title, inputId, label, onClose, onSave }: SaveNameModalProps) {
  const [name, setName] = useState("");

  return (
    <Modal onClose={onClose} title={title}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <div className="form-group">
          <label htmlFor={inputId}>{label}</label>
          <input autoFocus id={inputId} onChange={(event) => setName(event.target.value)} type="text" value={name} />
        </div>
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button save-button" disabled={!name.trim()} type="submit">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
