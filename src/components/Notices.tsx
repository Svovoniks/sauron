import type { Notice } from "../types/app";

interface NoticesProps {
  notices: Notice[];
  onDismiss: (id: number) => void;
}

export function Notices({ notices, onDismiss }: NoticesProps) {
  if (notices.length === 0) return null;

  return (
    <div aria-live="polite" className="notices">
      {notices.map((notice) => (
        <div className={`notice ${notice.kind}`} key={notice.id} role={notice.kind === "error" ? "alert" : "status"}>
          <span className="notice-text">{notice.text}</span>
          <button aria-label="Dismiss" className="notice-close" onClick={() => onDismiss(notice.id)} type="button">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
