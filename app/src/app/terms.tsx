// Terms of service (DRAFT, 2026-11-19): written from how the app actually works; to be reviewed by a lawyer before
// launch (lib/legal.ts LEGAL_REVIEWED). @anlim
import { Text, View } from "react-native";
import { c } from "../lib/theme";
import { Doc, H, Li, P, PublicFrame } from "../components/PublicFrame";
import { LAST_UPDATED, LEGAL_REVIEWED, OPERATOR, OPERATOR_PLACE, SUPPORT_EMAIL } from "../lib/legal";

export function DraftNote() {
  if (LEGAL_REVIEWED) return null;
  return (
    <View style={{ backgroundColor: c.flagBg, borderColor: c.flagLine, borderWidth: 1, borderRadius: 10, padding: 12 }}>
      <Text style={{ color: c.flag, fontSize: 13 }}>Draft: this page has not yet been reviewed by a lawyer and may change before anlim.ai launches.</Text>
    </View>
  );
}
export const contact = () => SUPPORT_EMAIL || "the contact address on the Help page (coming soon)";

export default function Terms() {
  return (
    <PublicFrame>
      <Doc title="Terms of service">
        <DraftNote />
        <P>Last updated {LAST_UPDATED}. anlim.ai is run by {OPERATOR} ({OPERATOR_PLACE}). By creating an account you agree to these terms.</P>
        <H>Your account</H>
        <Li>You need a confirmed email address. Keep your password to yourself; you are responsible for what happens in your account.</Li>
        <Li>One person, one account. Free starter credits are given once per person; we may withhold or remove them where an account is made to collect them again.</Li>
        <Li>You can delete your account at any time in Account › Delete account. That removes your work and cancels any plan.</Li>
        <H>Credits and payment</H>
        <Li>Making frames and clips costs credits, shown before you start. Scene cuts are free. Audio made with your own ElevenLabs account uses your ElevenLabs credits, not anlim credits.</Li>
        <Li>Images (start and end frames, location plates) are charged when they are made, whether you keep them or not. A clip is charged when it is made, whether you keep it or not; a render that does not finish costs nothing. You may request a refund for an unusable clip within 7 days, saying what is wrong. The credits are returned at once and the request is reviewed; if the problem cannot be confirmed, the credits are taken back (from your next credits if needed) and you are told why. At most 5 requests can wait for review at a time.</Li>
        <Li>Payments are handled by Stripe. Plans renew monthly until you cancel in Credits & plan; cancelling stops the next renewal. Unused credits are not refunded in cash, except where the law requires it.</Li>
        <Li>Free accounts get watermarked clips and cuts; buying credits or a plan removes the watermark from everything you make.</Li>
        <H>What you make</H>
        <Li>You keep the rights you have in what you upload and what you make with anlim, subject to the terms of the AI model providers that generate it and to the law where you publish it.</Li>
        <Li>You give us permission to store and process your uploads and results only to run the service for you (making frames, clips, checks and cuts).</Li>
        <Li>Only upload pictures, voices and music you have the right to use. Do not use anlim to make content that depicts real people without their consent, sexual content involving minors, content that harasses or deceives people, or anything illegal. We may remove such content and close accounts that make it.</Li>
        <Li>When you upload a photo or video of a person, you confirm that they are you or agreed that you may use their likeness; anlim keeps that confirmation with the file.</Li>
        <Li>Before an image, clip or sound is made, anlim checks the words and pictures it would use. Requests for sexual content or nudity, real public figures in photoreal pictures or video, real people shown in a sexual, humiliating or deceptive way, hate, graphic gore, self-harm or harassment are refused, and nothing is charged for them.</Li>
        <Li>Label AI-made video where the platform you publish on asks you to.</Li>
        <H>Connected accounts</H>
        <P>If you connect your ElevenLabs account, anlim uses your API key only to make the audio you ask for. You can disconnect at any time; that deletes the key. Your use of ElevenLabs is also under ElevenLabs' own terms.</P>
        <H>The service</H>
        <Li>AI models can produce mistakes. The anlim check helps but cannot catch everything; look at your clips before you publish them.</Li>
        <Li>We work to keep anlim available but cannot promise it will always be. We may change features and prices; price changes for plans apply from your next renewal, with notice.</Li>
        <Li>To the extent the law allows, our liability for any claim is limited to what you paid us in the 12 months before it.</Li>
        <H>Contact</H>
        <P>Questions about these terms: {contact()}.</P>
      </Doc>
    </PublicFrame>
  );
}
