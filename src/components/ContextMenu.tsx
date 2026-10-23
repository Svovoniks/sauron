import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { type: "label"; text: string }
  | { type: "separator" }
  | { type?: "item"; label: ReactNode; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void };

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** A menu at a screen position: arrow keys, Enter, Escape and outside clicks work. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const selectable = items.map((item, index) => ({ item, index })).filter(({ item }) => (item.type ?? "item") === "item" && !(item as { disabled?: boolean }).disabled);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, y + rect.height > window.innerHeight - 8 ? y - rect.height : y),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || (event.ctrlKey && !event.metaKey && !event.altKey && ["n", "p"].includes(event.key.toLowerCase()))) {
        event.preventDefault();
        event.stopPropagation();
        const forward = event.key === "ArrowDown" || event.key.toLowerCase() === "n";
        setActive((current) => {
          const at = selectable.findIndex(({ index }) => index === current);
          const next = forward ? (at + 1) % selectable.length : (at - 1 + selectable.length) % selectable.length;
          return selectable[next]?.index ?? -1;
        });
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        event.stopPropagation();
        const item = items[active];
        if (item && (item.type ?? "item") === "item") {
          onCloseRef.current();
          (item as { onSelect: () => void }).onSelect();
        }
      }
    };
    const onPointer = (event: MouseEvent) => {
      // A click on the control that opened the menu (marked data-menu-anchor) is its toggle: it closes the menu itself.
      if ((event.target as HTMLElement).closest?.("[data-menu-anchor]")) return;
      if (!ref.current?.contains(event.target as Node)) onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  });

  return createPortal(
    <div className="context-menu" ref={ref} role="menu" style={{ left: position.left, top: position.top }}>
      {items.map((item, index) => {
        if (item.type === "separator") return <hr key={index} />;
        if (item.type === "label") return <div className="context-menu-label" key={index}>{item.text}</div>;
        return (
          <button
            className={`${item.danger ? "danger" : ""} ${active === index ? "active" : ""}`}
            disabled={item.disabled}
            key={index}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            onMouseEnter={() => setActive(index)}
            role="menuitem"
            type="button"
          >
            <span className="mi-check">{item.checked ? "✓" : ""}</span>
            {item.icon ? <span className="mi-icon">{item.icon}</span> : null}
            <span className="mi-label">{item.label}</span>
            {item.hint ? <span className="mi-hint">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
