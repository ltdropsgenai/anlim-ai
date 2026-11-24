// A video guide on the Help page (web): plain HTML video with captions, loaded only when played. @anlim
import type { Tutorial } from "../lib/tutorials";
import { tr } from "../lib/i18n";

export function TutorialVideo({ t }: { t: Tutorial }) {
  return (
    <video src={t.file} poster={t.poster} controls playsInline preload="none" aria-label={t.title}
      style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 10, background: "#000", display: "block" }}>
      {t.captions ? <track kind="captions" src={t.captions} srcLang="en" label={tr("English")} default /> : null}
    </video>
  );
}
