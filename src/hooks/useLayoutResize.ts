import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Axis = "both" | "x" | "y";

const DEFAULT_SIDEBAR_WIDTH = 350;
const DEFAULT_QUERY_HEIGHT = 185;
const MIN_SIDEBAR_WIDTH = 220;
const MIN_RESULTS_WIDTH = 320;
const MIN_MAIN_HEIGHT = 160;
const MIN_QUERY_HEIGHT = 150;
const LAYOUT_GAP = 10;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);

interface ResizeState {
  axis: Axis;
  pointerId: number;
  startX: number;
  startY: number;
  sidebarWidth: number;
  queryHeight: number;
  maximumSidebarWidth: number;
  maximumQueryHeight: number;
}

/** Drag / keyboard resizing of the sidebar width and the query panel height. */
export function useLayoutResize() {
  const appContainerRef = useRef<HTMLDivElement | null>(null);
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [queryHeight, setQueryHeight] = useState(DEFAULT_QUERY_HEIGHT);
  const [resizeAxis, setResizeAxis] = useState<Axis | null>(null);

  const start = (event: ReactPointerEvent<HTMLElement>, axis: Axis) => {
    if (event.button !== 0 || !mainContentRef.current || !appContainerRef.current) return;

    const sidebar = mainContentRef.current.querySelector<HTMLElement>(".sidebar");
    const querySection = appContainerRef.current.querySelector<HTMLElement>(".query-section");
    if (!sidebar || !querySection) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const mainRect = mainContentRef.current.getBoundingClientRect();
    const sharedVerticalSpace = mainRect.height + LAYOUT_GAP + querySection.getBoundingClientRect().height;

    resizeRef.current = {
      axis,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      queryHeight: querySection.getBoundingClientRect().height,
      maximumSidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, mainRect.width - LAYOUT_GAP - MIN_RESULTS_WIDTH),
      maximumQueryHeight: Math.max(MIN_QUERY_HEIGHT, sharedVerticalSpace - LAYOUT_GAP - MIN_MAIN_HEIGHT),
    };
    setResizeAxis(axis);
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    if (resize.axis !== "y") {
      setSidebarWidth(
        clamp(resize.sidebarWidth + event.clientX - resize.startX, MIN_SIDEBAR_WIDTH, resize.maximumSidebarWidth),
      );
    }
    if (resize.axis !== "x") {
      setQueryHeight(
        clamp(resize.queryHeight - (event.clientY - resize.startY), MIN_QUERY_HEIGHT, resize.maximumQueryHeight),
      );
    }
  };

  const stop = (event: ReactPointerEvent<HTMLElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;

    resizeRef.current = null;
    setResizeAxis(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLElement>, axis: Axis = "both") => {
    const increment = event.shiftKey ? 24 : 8;

    if (event.key === "ArrowLeft" && axis !== "y") {
      event.preventDefault();
      setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, width - increment));
    } else if (event.key === "ArrowRight" && axis !== "y") {
      event.preventDefault();
      const mainWidth = mainContentRef.current?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
      setSidebarWidth((width) => Math.min(mainWidth - LAYOUT_GAP - MIN_RESULTS_WIDTH, width + increment));
    } else if (event.key === "ArrowUp" && axis !== "x") {
      event.preventDefault();
      const querySection = appContainerRef.current?.querySelector<HTMLElement>(".query-section");
      const mainHeight = mainContentRef.current?.getBoundingClientRect().height;
      const maximumQueryHeight =
        querySection && mainHeight !== undefined
          ? Math.max(MIN_QUERY_HEIGHT, mainHeight + querySection.getBoundingClientRect().height - MIN_MAIN_HEIGHT)
          : Number.POSITIVE_INFINITY;
      setQueryHeight((height) => Math.min(maximumQueryHeight, height + increment));
    } else if (event.key === "ArrowDown" && axis !== "x") {
      event.preventDefault();
      setQueryHeight((height) => Math.max(MIN_QUERY_HEIGHT, height - increment));
    }
  };

  const reset = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setQueryHeight(DEFAULT_QUERY_HEIGHT);
  };

  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--query-section-height": `${queryHeight}px`,
  } as CSSProperties;

  return { appContainerRef, mainContentRef, layoutStyle, resizeAxis, start, move, stop, resizeWithKeyboard, reset };
}
