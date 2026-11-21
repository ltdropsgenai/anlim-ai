// iOS / Android (2026-11-20): no sun light yet; the stage is the plain page background. Same API as SunLight.web.tsx.
// @anlim
import { ReactNode } from "react";
import { View } from "react-native";
import { c } from "../lib/theme";

export function SunStage({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, backgroundColor: c.bg }}>{children}</View>;
}
