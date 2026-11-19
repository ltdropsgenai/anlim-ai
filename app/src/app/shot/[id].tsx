// One shot on its own page (phone widths and direct links). The workflow itself is components/ShotPanel. @anlim
import { router, useLocalSearchParams } from "expo-router";
import { ShotPanel } from "../../components/ShotPanel";

export default function ShotScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ShotPanel id={id} onRendered={() => router.replace("/review")} onDeleted={() => router.replace("/workspace")} />;
}
