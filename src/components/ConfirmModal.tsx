import { Modal } from "./Modal";

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({ title, message, confirmText = "Delete", onClose, onConfirm }: ConfirmModalProps) {
  return (
    <Modal onClose={onClose} title={title}>
      <div className="modal-form">
        <p className="modal-message">{message}</p>
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button delete-button" onClick={onConfirm} type="button">
            {confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
