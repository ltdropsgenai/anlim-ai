// Native: start stills are added from the web app for now (no picker dependency in this build). @anlim
import { Text } from "react-native";
import { tr } from "../lib/i18n";

export function StillPicker(_: {
  label: string; disabled?: boolean; onPick: (file: File) => void; onError: (msg: string) => void;
  style?: object; textStyle?: object;
  // other files (2026-11-19: music for scene cuts): accepted types, size limit and the wrong-type message
  types?: string[]; maxMb?: number; typeError?: string;
}) {
  return <Text style={{ color: "#A1A1AA", fontSize: 13 }}>{tr("Add start frames from the web app for now.")}</Text>;
}
