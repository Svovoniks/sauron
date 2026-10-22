import { useCallback, useRef, useState } from "react";
import type { Notice } from "../types/app";

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const notify = useCallback(
    (kind: Notice["kind"], text: string) => {
      const id = nextId.current++;
      setNotices((current) => [...current.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 20_000 : 6_000);
    },
    [dismiss],
  );

  return { notices, notify, dismiss };
}
