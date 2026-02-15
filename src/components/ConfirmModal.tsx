interface ConfirmModalProps {
  show: boolean;
  title: string;
  message: string;
  confirmText?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  show,
  title,
  message,
  confirmText = "Delete",
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  if (!show) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{title}</h3>
        <div className="modal-form">
          <p className="modal-message">{message}</p>
          <div className="modal-buttons">
            <button className="button cancel-button" onClick={onClose} type="button">Cancel</button>
            <button className="button delete-button" onClick={onConfirm} type="button">{confirmText}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
