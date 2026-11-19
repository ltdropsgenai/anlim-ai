// A small audio player (web). @anlim
export function AudioPlayer({ src }: { src: string }) {
  return <audio src={src} controls preload="none" style={{ width: "100%", maxWidth: 420, height: 36, display: "block" }} />;
}
