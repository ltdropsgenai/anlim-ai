// anlim.ai/assets opens Assets (the page lives at /storage; the sidebar and the tutorials call it Assets). @anlim
import { Redirect } from "expo-router";
export default function AssetsRedirect() { return <Redirect href="/storage" />; }
