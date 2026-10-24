import { useEffect, useId, useRef, type RefObject } from "react";

// Scene geometry, in viewBox units. The eye turns left and right in a horizontal plane on top of the tower and looks
// down at a fixed angle, so the spot it lights travels along an arc of a circle on the ground in front of the tower.
// The ground is seen from slightly above (TILT), which makes that circle an ellipse: the spot is lowest straight
// ahead and rises toward the sides.
const EYE_X = 300;
const EYE_Y = 78;
const BASE_Y = 324;
const TILT = (8 * Math.PI) / 180;
/** Radius of the lit circle on the ground. */
const REACH = 279;
const FLATTEN = Math.sin(TILT);
/** How far left and right of straight ahead the eye turns. */
const SWEEP = (49 * Math.PI) / 180;

/** The eye: a straight upper lid (tilted down toward the left) and a deep half-ellipse below it. */
const EYE_SHAPE = "M-28 -3 L28 -9 A28 20 0 0 1 -28 -3 Z";

/**
 * Outline of a cone of light: the apex (the eye) and the ellipse it lights on the ground, i.e. the convex hull of a
 * point and an ellipse. Built in a space where the ellipse is a circle so the tangent points are easy to find.
 */
function cone(apexX: number, apexY: number, cx: number, cy: number, rx: number, ry: number): string {
  const squash = rx / ry;
  const ax = apexX - cx;
  const ay = (apexY - cy) * squash;
  const dist = Math.hypot(ax, ay);
  const facing = Math.atan2(ay, ax);
  const half = Math.acos(Math.min(1, rx / dist));
  const point = (angle: number) => `${(cx + rx * Math.cos(angle)).toFixed(1)} ${(cy + (rx * Math.sin(angle)) / squash).toFixed(1)}`;
  // From one tangent point round the far side of the ellipse to the other (the side facing away from the eye).
  const steps = 18;
  let d = `M${apexX.toFixed(1)} ${apexY.toFixed(1)}`;
  for (let i = 0; i <= steps; i++) d += ` L${point(facing + half + ((2 * Math.PI - 2 * half) * i) / steps)}`;
  return `${d} Z`;
}

interface Layer {
  group: RefObject<SVGGElement>;
  haze: RefObject<SVGPathElement>;
  core: RefObject<SVGPathElement>;
  spot: RefObject<SVGEllipseElement>;
}

/** The refs inside are stable, but the object is new on every render: callers must not list it as an effect dependency. */
const useLayer = (): Layer => ({ group: useRef(null), haze: useRef(null), core: useRef(null), spot: useRef(null) });

/**
 * The alternative to the logo-style `SauronEye` (Settings -> General -> Loading animation).
 * The "query is running" animation: an eye on top of a dark tower, turning left and right and looking down, so its
 * beam sweeps across the ground in front of the tower and lights a moving spot there. The beam widens and fades
 * with distance and falls over the tower. Pure SVG, driven from a requestAnimationFrame loop. Colors come from the
 * theme (--warn flame, --err core). It ignores "reduce motion" on purpose: it is the loading indicator.
 */
export function SauronTower() {
  const id = useId().replace(/:/g, "");
  const layer = useLayer();
  const eye = useRef<SVGGElement>(null);
  const pupil = useRef<SVGEllipseElement>(null);
  const hazeFade = useRef<SVGLinearGradientElement>(null);
  const coreFade = useRef<SVGLinearGradientElement>(null);

  useEffect(() => {
    const period = 5_100; // one trip left and back
    const start = performance.now();
    let raf = 0;

    const draw = (elapsed: number) => {
      // 0 = straight ahead (at us); eases in and out at both ends, starting at the far left.
      const yaw = -SWEEP * Math.cos((elapsed / period) * 2 * Math.PI);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const hitX = EYE_X + REACH * sin;
      const hitY = BASE_Y + REACH * cos * FLATTEN;
      const length = Math.hypot(hitX - EYE_X, hitY - EYE_Y);
      // Straight ahead the beam is closest to us, so a little bigger and brighter than when it points to the side.
      const near = 0.5 + 0.5 * cos;
      const footprint = (0.13 + 0.13 * near) * length;
      const hazeD = cone(EYE_X, EYE_Y, hitX, hitY, footprint, footprint * FLATTEN * 1.1);
      const coreD = cone(EYE_X, EYE_Y, hitX, hitY, footprint * 0.3, footprint * 0.3 * FLATTEN * 1.1);
      for (const fade of [hazeFade.current, coreFade.current]) {
        fade?.setAttribute("x2", hitX.toFixed(1));
        fade?.setAttribute("y2", hitY.toFixed(1));
      }
      layer.group.current?.setAttribute("opacity", (0.7 + 0.3 * near).toFixed(2));
      layer.haze.current?.setAttribute("d", hazeD);
      layer.core.current?.setAttribute("d", coreD);
      const spot = layer.spot.current;
      spot?.setAttribute("cx", hitX.toFixed(1));
      spot?.setAttribute("cy", hitY.toFixed(1));
      spot?.setAttribute("rx", (footprint * 1.1).toFixed(1));
      spot?.setAttribute("ry", (footprint * 1.1 * FLATTEN * 1.1).toFixed(1));

      // The eye looks where the beam goes: the pupil slides sideways and the eye tilts a little.
      eye.current?.setAttribute("transform", `rotate(${(22.5 * sin).toFixed(2)})`);
      pupil.current?.setAttribute("transform", `translate(${(15 * sin).toFixed(2)} 0)`);
    };

    const frame = (now: number) => {
      draw(now - start);
      raf = requestAnimationFrame(frame);
    };
    draw(0);
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // Mount only. The parent re-renders every 100 ms (the elapsed-time label); restarting here would reset the sweep each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beam = (layer: Layer) => (
    <g ref={layer.group}>
      <path fill={`url(#${id}-haze)`} filter={`url(#${id}-blur)`} ref={layer.haze} />
      <path fill={`url(#${id}-core)`} ref={layer.core} />
      <ellipse fill={`url(#${id}-spot)`} ref={layer.spot} />
    </g>
  );

  return (
    <svg aria-label="Searching" className="eye-scene" role="img" viewBox="0 0 600 400">
      <defs>
        {/* Fades run from the eye to where the beam lands (x2/y2 follow the beam, see draw()). */}
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}-core`} ref={coreFade} x1={EYE_X} x2={EYE_X} y1={EYE_Y} y2={BASE_Y}>
          <stop offset="0" stopColor="var(--warn)" stopOpacity="1" />
          <stop offset="0.45" stopColor="var(--warn)" stopOpacity="0.44" />
          <stop offset="1" stopColor="var(--warn)" stopOpacity="0.24" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}-haze`} ref={hazeFade} x1={EYE_X} x2={EYE_X} y1={EYE_Y} y2={BASE_Y}>
          <stop offset="0" stopColor="var(--err)" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="var(--warn)" stopOpacity="0.19" />
          <stop offset="1" stopColor="var(--warn)" stopOpacity="0.14" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="var(--warn)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--warn)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-spot`}>
          <stop offset="0" stopColor="var(--warn)" stopOpacity="0.99" />
          <stop offset="0.5" stopColor="var(--warn)" stopOpacity="0.38" />
          <stop offset="1" stopColor="var(--warn)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-eye`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--warn)" />
          <stop offset="1" stopColor="var(--err)" />
        </linearGradient>
        <filter height="140%" id={`${id}-blur`} width="140%" x="-20%" y="-20%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <clipPath id={`${id}-lid`}>
          <path d={EYE_SHAPE} />
        </clipPath>
        {/* Left half of the tower; the right half is the mirror image. */}
        <path
          d="M300 322 L150 322 L176 276 L196 276 L206 228 L224 228 L230 182 L246 182 L250 144 L262 144 L266 122 L277 122 L278 104 C270 92 260 78 264 60 C272 76 286 94 300 106 Z"
          id={`${id}-half`}
        />
      </defs>

      {/* The ground under the tower. */}
      <ellipse className="eye-ground" cx={EYE_X} cy={BASE_Y} rx="190" ry="6" />

      <g className="eye-tower">
        <use href={`#${id}-half`} />
        <use href={`#${id}-half`} transform="translate(600 0) scale(-1 1)" />
        <g className="eye-windows">
          <rect height="9" rx="1.5" width="4" x="298" y="140" />
          <rect height="9" rx="1.5" width="4" x="298" y="190" />
          <rect height="9" rx="1.5" width="4" x="298" y="238" />
          <rect height="9" rx="1.5" width="4" x="279" y="196" />
          <rect height="9" rx="1.5" width="4" x="317" y="196" />
          <rect height="9" rx="1.5" width="4" x="262" y="248" />
          <rect height="9" rx="1.5" width="4" x="334" y="248" />
        </g>
      </g>

      {/* Over the tower: the light falls on it. */}
      {beam(layer)}

      <g transform={`translate(${EYE_X} ${EYE_Y})`}>
        <circle className="eye-halo" fill={`url(#${id}-glow)`} r="58" />
        <g ref={eye}>
          <g transform="scale(0.85)">
            {/* A flat, heavy upper lid (a little lower on one side) over a deep bowl, so it glares; the pupil is a slit hanging low in it. */}
            <path d={EYE_SHAPE} fill={`url(#${id}-eye)`} />
            <g clipPath={`url(#${id}-lid)`}>
              <g transform="translate(0 8)">
                <ellipse className="eye-pupil" cx="0" cy="0" ref={pupil} rx="3.15" ry="11.2" />
              </g>
            </g>
            <path d="M-29 -3 L29 -9" fill="none" stroke="var(--err)" strokeLinecap="round" strokeWidth="2.6" />
          </g>
        </g>
      </g>
    </svg>
  );
}
