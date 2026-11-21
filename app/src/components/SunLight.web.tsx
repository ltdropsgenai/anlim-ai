// The welcome page and Home sit in front of a distant sun (2026-11-20, Londi: "a ray of light ... from somewhere deep
// within the screen and flash like the rays of the sun", backlighting everything it hits). The light sits behind the
// page; each glass card's rim lights on the side that faces it, more for cards nearer the light. Look: anlim-sun CSS in
// _layout.tsx. Rays turn with a CSS animation (compositor only); the flash is one CSS variable set from here. @anlim
import { ReactNode, useEffect, useRef } from "react";

const SUN_X = 0.5, SUN_Y = 0.3;   // where the light sits in the stage, as fractions of its width and height

export function SunStage({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, alive = true;

    // rims: each card's angle toward the light and how near it is (on scroll, resize and a slow tick, not per frame)
    const aim = () => {
      const r = el.getBoundingClientRect();
      const sx = r.left + r.width * SUN_X, sy = r.top + r.height * SUN_Y, far = Math.hypot(r.width, r.height) * 0.6;
      el.querySelectorAll<HTMLElement>(".anlim-glass").forEach((card) => {
        const b = card.getBoundingClientRect();
        const dx = sx - (b.left + b.width / 2), dy = sy - (b.top + b.height / 2);
        card.style.setProperty("--to-sun", `${((Math.atan2(dx, -dy) * 180) / Math.PI).toFixed(1)}deg`);
        card.style.setProperty("--near", Math.max(0.35, 1 - Math.hypot(dx, dy) / far).toFixed(3));
      });
    };
    let queued = false;
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; aim(); }); } };
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    const tick = window.setInterval(aim, 700);   // cards that load later (prices, the creator's data)
    aim();

    // the flash: a fast rise and a slow fall every 6-10 s; about one in three gets a second, smaller glint
    if (!still) {
      let next = performance.now() + 1500, start = -1e9, peak = 1;
      const frame = (t: number) => {
        if (!alive) return;
        if (t >= next) {
          start = t; peak = 0.8 + Math.random() * 0.2; next = t + 6000 + Math.random() * 4000;
          if (Math.random() < 0.35) window.setTimeout(() => { start = performance.now(); peak = 0.6; }, 900);
        }
        const k = (t - start) / 1000;
        const v = k < 0 ? 0 : k < 0.35 ? Math.sin(((k / 0.35) * Math.PI) / 2) : Math.exp(-(k - 0.35) * 2.2);
        el.style.setProperty("--flash", (0.3 + 0.7 * peak * v).toFixed(3));
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }
    return () => {
      alive = false; cancelAnimationFrame(raf); window.clearInterval(tick);
      el.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return (
    <div ref={stage} className="anlim-stage" style={{ ["--sx" as string]: `${SUN_X * 100}%`, ["--sy" as string]: `${SUN_Y * 100}%` }}>
      <div className="anlim-sun" aria-hidden="true">
        <div className="anlim-sun__pulse"><div className="anlim-sun__rays anlim-sun__rays--b" /></div>
        <div className="anlim-sun__pulse"><div className="anlim-sun__rays" /></div>
        <div className="anlim-sun__halo" />
        <div className="anlim-sun__core" />
      </div>
      {children}
    </div>
  );
}
