// anlim.ai mark, direction D "Tally dot" (Londi, 2026-11-19): a lowercase a with an orange recording-light dot. @anlim
// Sizes under 40 px use the heavier strokes drawn for small sizes on the logo board.
export function Logo({ size = 40 }: { size?: number }) {
  const sw = size <= 20 ? 12 : size <= 36 ? 10 : 9;
  const dot = size <= 20 ? 10 : size <= 36 ? 8 : 7;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="anlim.ai" style={{ display: "block" }}>
      <rect width="100" height="100" rx="24" fill="#16161A" />
      <circle cx="42" cy="56" r="16" fill="none" stroke="#F4F4F5" strokeWidth={sw} />
      <rect x={58 - sw / 2} y="34" width={sw} height="38" rx="3" fill="#F4F4F5" />
      <circle cx="76" cy="68" r={dot} fill="#FF7A1A" />
    </svg>
  );
}
