// Web player: an HTML video with a marker strip; clicking a flagged moment jumps there and pauses. @anlim
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { c } from "../lib/theme";

export type Marker = { t: number; color: string; label: string };
export type PlayerHandle = { seek: (t: number) => void };

export const ClipPlayer = forwardRef<PlayerHandle, { src: string; duration: number; markers: Marker[] }>(
  function ClipPlayer({ src, duration, markers }, ref) {
    const v = useRef<HTMLVideoElement>(null);
    const [now, setNow] = useState(0);
    const [len, setLen] = useState(duration);
    const seek = (t: number) => { if (v.current) { v.current.pause(); v.current.currentTime = Math.max(0, t); } };
    useImperativeHandle(ref, () => ({ seek }));
    return (
      <div style={{ width: "100%" }}>
        <video ref={v} src={src} controls playsInline loop={false}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setLen(e.currentTarget.duration || duration)}
          style={{ width: "100%", borderRadius: 10, background: "#000", display: "block" }} />
        <div style={{ position: "relative", height: 26, marginTop: 8, background: c.line, borderRadius: 6 }}
          aria-label="Flagged moments timeline">
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(now / len) * 100}%`,
            background: "rgba(255,122,26,0.22)", borderRadius: 6 }} />
          {markers.map((m, i) => (
            <button key={i} title={`${m.t.toFixed(2)} s · ${m.label}`} onClick={() => seek(m.t)}
              style={{ position: "absolute", left: `calc(${(m.t / len) * 100}% - 5px)`, top: 3, width: 10, height: 20,
                borderRadius: 3, border: "none", background: m.color, cursor: "pointer", padding: 0 }} />
          ))}
        </div>
      </div>
    );
  });
