// Native player comes later (expo-video); the review screen is web first.
import { forwardRef } from "react";
import { Text } from "react-native";
import { tr } from "../lib/i18n";
export type Marker = { t: number; color: string; label: string };
export type PlayerHandle = { seek: (t: number) => void };
export const ClipPlayer = forwardRef<PlayerHandle, { src: string; duration: number; markers: Marker[] }>(
  function ClipPlayer() { return <Text>{tr("Video review is available on the web app for now.")}</Text>; });
