// Help & contact (2026-11-19): short answers to what creators ask, and how to reach a person. @anlim
import { useEffect, useState } from "react";
import { View } from "react-native";
import { supabase } from "../lib/supabase";
import { Doc, H, Li, P, PublicFrame } from "../components/PublicFrame";
import { contact } from "./terms";
import { TUTORIALS } from "../lib/tutorials";
import { TutorialVideo } from "../components/TutorialVideo";
import { tr } from "../lib/i18n";

export default function Support() {
  // signed in: the top bar offers "Open the studio" (back to the app) instead of "Sign in" / "Start free"
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session)).catch(() => {}); }, []);
  return (
    <PublicFrame signedIn={signedIn}>
      <Doc title={tr("Help & contact")}>
        {TUTORIALS.length > 0 && <>
          <H>{tr("Video guides")}</H>
          {TUTORIALS.map((t) => (<View key={t.ep} style={{ gap: 6, marginBottom: 12 }}>
            <TutorialVideo t={t} />
            <P>{tr("{title} · {v1} min. {what}", { title: t.title, v1: Math.round(t.seconds / 60) || 1, what: t.what })}</P>
          </View>))}
        </>}
        <H>{tr("A clip didn't come out right")}</H>
        <P>{tr("Open it in Review: the anlim check lists what it saw. Render it again if it is not what you wanted. Every clip is charged when it is made, because the video model is paid for every render. If a clip is unusable (a broken body, an object that changes, the wrong action), open it in Review and choose Reject: say what is wrong and when. We look at every rejected clip within a few days. If we can see the problem, the credits come back to you; if we cannot, we tell you why and the charge stands.")}</P>
        <H>{tr("My characters look different from shot to shot")}</H>
        <P>{tr("Give each character a clear, front-on reference picture in Cast & places, and start each shot from a frame anlim made in your location (New setup), not from a loose upload.")}</P>
        <H>{tr("Why is my clip watermarked?")}</H>
        <P>{tr("Free accounts get watermarked clips and cuts. Buy credits or a plan and everything you make plays without it, old clips included.")}</P>
        <H>{tr("How do I cancel my plan?")}</H>
        <P>{tr("Credits & plan › Manage plan. Cancelling stops the next renewal; you keep your credits until then.")}</P>
        <H>{tr("How do I delete my account?")}</H>
        <P>{tr("Account › Delete my account…. It removes everything and cannot be undone, so download what you want to keep first.")}</P>
        <H>{tr("Use anlim from Claude, ChatGPT or another AI tool")}</H>
        <P>{tr("anlim works as a connector (an MCP server), so you can ask your AI assistant to make an image or a clip, check on it, list your projects or see your credits. Making images and clips from chat needs a paid account and uses your credits, as in the app (at most 5 every 10 minutes). The address is https://mcp.anlim.ai/mcp.")}</P>
        <Li>{tr("Claude: Customize › Connectors › + Add › Add custom connector. Name it anlim, paste the address, Add, then Connect and sign in to anlim.")}</Li>
        <Li>{tr("ChatGPT (web): Plugins › + › Add custom MCP server. Name it anlim, paste the address, choose OAuth, then sign in to anlim. ChatGPT lets only some plans use tools that make things (Business and Enterprise); on other plans it may only read your projects and clips.")}</Li>
        <Li>{tr("Other tools (Claude Code, Cursor, any MCP client): add a remote MCP server with the same address; the tool opens anlim's sign-in.")}</Li>
        <P>{tr("When the tool asks to connect, anlim shows what it may do; choose Approve. To disconnect, remove the connector in the tool.")}</P>
        <P>{tr("From chat you can make images and clips, add characters from your photos, set backgrounds, build a scene shot by shot, keep or reject clips, recast a video (motion transfer) and make the cut. A chat can't send files to anlim, so when your AI tool needs a photo or a video it gives you the link anlim.ai/upload: drop the files there and tell it you're done.")}</P>
        <H>{tr("Contact")}</H>
        <P>{tr("Write to {v0}. If you saw an error with a reference code, include it.", { v0: contact() })}</P>
      </Doc>
    </PublicFrame>
  );
}
