// Web: pick a start still from disk (PNG, JPEG or WebP, up to 15 MB). @anlim
import { useRef } from "react";
import { Pressable, Text } from "react-native";
import { tr } from "../lib/i18n";

const TYPES = ["image/png", "image/jpeg", "image/webp"];

export function StillPicker({ label, disabled, onPick, onError, style, textStyle, types, maxMb, typeError }: {
  label: string; disabled?: boolean; onPick: (file: File) => void; onError: (msg: string) => void;
  style?: object; textStyle?: object;
  // other files (2026-11-19: music for scene cuts): accepted types, size limit and the wrong-type message
  types?: string[]; maxMb?: number; typeError?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={input} type="file" accept={(types ?? TYPES).join(",")} style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          if (!(types ?? TYPES).includes(f.type)) return onError(typeError ?? tr("Use a PNG, JPEG or WebP image."));
          if (f.size > (maxMb ?? 15) * 1024 * 1024) return onError(tr("That file is over {v0} MB.", { v0: maxMb ?? 15 }));
          onPick(f);
        }} />
      <Pressable style={style} disabled={disabled} accessibilityRole="button" onPress={() => input.current?.click()}>
        <Text style={textStyle}>{label}</Text>
      </Pressable>
    </>
  );
}
