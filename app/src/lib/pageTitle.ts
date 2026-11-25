// Browser tab title for pages outside the studio Shell (2026-11-25 launch audit: public pages showed the bare URL). @anlim
import { useEffect } from "react";
import { Platform } from "react-native";

export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    document.title = title ? `${title} · anlim.ai` : "anlim.ai · AI video where your cast stays the same";
  }, [title]);
}
