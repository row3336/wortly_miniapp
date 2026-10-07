import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { prefersReducedMotion } from "./navigationMotion";
import "./launch.css";

/** М20 (TA:44, RA табл. 6.1.6, §6.1.5): the book assembly lasts 2400 ms, the exit 700 ms, one after the other. */
export const LAUNCH_BUILD_MS = 2400;
export const LAUNCH_EXIT_MS = 700;

/**
 * building: the assembly runs; waiting: it is over but the entry is not decided, so the logo stays with the spinner;
 * leaving: the exit runs; still: reduced motion, the finished logo without any motion until the entry is decided;
 * done: no launch screen exists any more.
 */
export type LaunchPhase = "building" | "waiting" | "leaving" | "still" | "done";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/**
 * The phase of the launch screen. `ready` is the entry being decided (success or refusal), never the timer:
 * the screen can neither shorten nor confirm the entry (RA:155). One launch per mounted owner; once the exit has
 * started it always finishes, whatever `ready` does afterwards.
 */
export function useLaunch(ready: boolean): LaunchPhase {
  // The system setting alone, read once: no motion switch of our own (TA:35). With reduced motion the accepted
  // prototype keeps the logo still instead of playing the assembly and the exit (app.js loadingPreview).
  const [still, setStill] = useState(() => prefersReducedMotion(window));
  const [over, setOver] = useState(false);
  const [built, setBuilt] = useState(false);
  // Latched: the first moment the assembly is over and the entry decided starts the exit for good.
  const [latched, setLatched] = useState(false);
  const exiting = !still && (latched || (built && ready));
  // A still logo goes at once, without motion, when the entry is decided; so does an exit the setting interrupted.
  const phase: LaunchPhase = over ? "done" : still ? (ready || latched ? "done" : "still")
    : exiting ? "leaving" : built ? "waiting" : "building";

  useEffect(() => {
    if (over || still) return;
    const query = window.matchMedia?.(reducedMotionQuery);
    const onChange = () => { if (query?.matches) setStill(true); };
    query?.addEventListener?.("change", onChange);
    return () => query?.removeEventListener?.("change", onChange);
  }, [over, still]);

  useEffect(() => {
    if (over || still) return;
    const timer = setTimeout(() => setBuilt(true), LAUNCH_BUILD_MS);
    return () => clearTimeout(timer);
  }, [over, still]);

  useEffect(() => { if (exiting) setLatched(true); }, [exiting]);

  useEffect(() => {
    if (phase === "done") setOver(true);
    if (phase !== "leaving") return;
    const timer = setTimeout(() => setOver(true), LAUNCH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return phase;
}

const timing = { "--launch-exit-ms": `${LAUNCH_EXIT_MS}ms` } as CSSProperties;

/** The exit is the same 700 ms for the logo and for the screen that appears under it. */
export function LaunchScreen({ phase }: { phase: Exclude<LaunchPhase, "done"> }) {
  return <div className={phase === "leaving" ? "launch launch--leaving" : phase === "still" ? "launch launch--still" : "launch"}
    data-phase={phase} style={timing}>
    {/* The brand name is not translated, so the logo needs no ru/uk/en copy. */}
    <div className="launch-logo" role="img" aria-label="Wortly">
      <div className="launch-books">
        {[1, 2, 3].map(index => <img key={index} className="launch-book" style={{ "--launch-book": index - 1 } as CSSProperties}
          src={`/launch/book-${index}.png`} alt="" width={238} height={270} draggable={false} />)}
      </div>
      <div className="launch-word" />
    </div>
    <svg className="launch-loader wortly-loader" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="var(--line)" />
      <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
      <circle className="wortly-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
    </svg>
  </div>;
}

/**
 * Wraps the whole application. The application renders and loads under the launch screen from the first frame:
 * the entry never waits for the animation. The wrapper keeps its place in the tree for every phase, so the
 * application is never remounted; it is only inert while the launch screen is on top, including the whole exit.
 */
export function LaunchHost({ ready, children }: { ready: boolean; children: ReactNode }) {
  const phase = useLaunch(ready);
  const running = phase !== "done";
  return <>
    <div className={phase === "leaving" ? "launch-host launch-host--entering" : "launch-host"} style={timing} inert={running}>
      {children}
    </div>
    {running && <LaunchScreen phase={phase} />}
  </>;
}
