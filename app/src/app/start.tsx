// Try it first (2026-11-19, Londi: "open to the screen where the prompt is displayed when we click on Start free and
// only prompt to create an account to view the results"). Visitors type their first shot here; pressing the arrow
// keeps it (lib/draft) and asks for an account; once signed in, the Home composer makes it on the new account. @anlim
import { useEffect, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { PublicFrame } from "../components/PublicFrame";
import { Composer } from "../components/Composer";
import { tr } from "../lib/i18n";

export default function Start() {
  const { width } = useWindowDimensions();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { if (data.session) router.replace("/"); else setReady(true); });
  }, []);
  return (
    <PublicFrame title={tr("Start free")}>
      <View style={{ paddingHorizontal: width < 700 ? 16 : 28, paddingBottom: 48 }}>
        {ready && <Composer narrow={width < 760} guest />}
      </View>
    </PublicFrame>
  );
}
