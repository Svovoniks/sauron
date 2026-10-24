/** Radius of the ring, in the 320-unit square the logo is drawn in. The fins' straight edges are tangent to it (their tips are at RING * sqrt 2), so they touch it. */
const RING = 98;
const CORNER = RING * Math.SQRT2;
const TOUCH = RING / Math.SQRT2;
/** One fin: from a tip down to the ring, between the vertical axis and a slanted edge, closed by the ring itself. */
const FIN = `M0 ${-CORNER} L${TOUCH} ${-TOUCH} A${RING} ${RING} 0 0 0 0 ${-RING} Z`;

/**
 * The "query is running" animation, drawn like the app icon: four fins turning slowly around a ringed eye whose pupil
 * looks from side to side. Black and white like the logo (the theme's text and background colors, so it inverts on a
 * light theme).
 *
 * The layers are separate boxes and only their `transform` is animated (see `.eye-*` in states.css), so the browser can
 * run the animation on the compositor: it keeps moving smoothly while the page is busy (parsing a big result,
 * rendering it) instead of freezing like an animation that needs the main thread for every frame.
 */
export function SauronEye() {
  return (
    <div aria-label="Searching" className="eye-logo" role="img">
      <svg aria-hidden="true" className="eye-layer eye-fins" viewBox="-160 -160 320 320">
        {[0, 90, 180, 270].map((angle) => (
          <path className="eye-fin" d={FIN} key={angle} transform={`rotate(${angle})`} />
        ))}
      </svg>
      <svg aria-hidden="true" className="eye-layer" viewBox="-160 -160 320 320">
        <circle className="eye-ring" r={RING} />
        <circle className="eye-ring thin" r={RING - 7} />
      </svg>
      {/* Half a disc under a flat lid, on the ring's horizontal diameter; the pupil is a disc on the lid, clipped by the eye. */}
      <div className="eye-lens">
        <span className="eye-pupil-dot" />
      </div>
    </div>
  );
}
