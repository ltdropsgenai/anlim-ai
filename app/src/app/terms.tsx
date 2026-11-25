// Terms of service (DRAFT, 2026-11-19): written from how the app actually works; to be reviewed by a lawyer before
// launch (lib/legal.ts LEGAL_REVIEWED). @anlim
import { Text, View } from "react-native";
import { c } from "../lib/theme";
import { Doc, H, Li, P, PublicFrame } from "../components/PublicFrame";
import { LAST_UPDATED, LEGAL_REVIEWED, OPERATOR, OPERATOR_PLACE, SUPPORT_EMAIL } from "../lib/legal";
import { tr, getLang } from "../lib/i18n";

export function DraftNote() {
  if (LEGAL_REVIEWED && getLang() === "en") return null;
  return (
    <View style={{ backgroundColor: c.flagBg, borderColor: c.flagLine, borderWidth: 1, borderRadius: 10, padding: 12 }}>
      {!LEGAL_REVIEWED && <Text style={{ color: c.flag, fontSize: 13 }}>{tr("Draft: this page has not yet been reviewed by a lawyer and may change before anlim.ai launches.")}</Text>}
      {getLang() !== "en" && <Text style={{ color: c.flag, fontSize: 13 }}>{tr("This translation is for convenience. If it differs from the English version, the English version applies.")}</Text>}
    </View>
  );
}
export const contact = () => SUPPORT_EMAIL || tr("the contact address on the Help page (coming soon)");

export default function Terms() {
  return (
    <PublicFrame title={tr("Terms")}>
      <Doc title={tr("Terms of service")}>
        <DraftNote />
        <P>{tr("Last updated {LAST_UPDATED}. anlim.ai is run by {OPERATOR} ({OPERATOR_PLACE}). By creating an account you agree to these terms.", { LAST_UPDATED: tr(LAST_UPDATED), OPERATOR, OPERATOR_PLACE: tr(OPERATOR_PLACE) })}</P>
        <H>{tr("Your account")}</H>
        <Li>{tr("You need a confirmed email address. Keep your password to yourself; you are responsible for what happens in your account.")}</Li>
        <Li>{tr("One person, one account. Free starter credits are given once per person; we may withhold or remove them where an account is made to collect them again.")}</Li>
        <Li>{tr("You can delete your account at any time in Account › Delete account. That removes your work and cancels any plan.")}</Li>
        <H>{tr("Credits and payment")}</H>
        <Li>{tr("Making frames and clips costs credits, shown before you start. Scene cuts are free. Audio made with your own ElevenLabs account uses your ElevenLabs credits, not anlim credits.")}</Li>
        <Li>{tr("Images (start and end frames, location plates) are charged when they are made, whether you keep them or not. A clip is charged when it is made, whether you keep it or not; a render that does not finish costs nothing. You may request a refund for an unusable clip within 7 days, saying what is wrong. We review every request within a few days: if we can see the problem, the credits come back to you; if we cannot, the charge stands and you are told why. At most 5 requests can wait for review at a time.")}</Li>
        <Li>{tr("Payments are handled by Stripe. Plans renew monthly until you cancel in Credits & plan; cancelling stops the next renewal. Unused credits are not refunded in cash, except where the law requires it.")}</Li>
        <Li>{tr("Free accounts get watermarked clips and cuts; buying credits or a plan removes the watermark from everything you make.")}</Li>
        <H>{tr("What you make")}</H>
        <Li>{tr("You keep the rights you have in what you upload and what you make with anlim, subject to the terms of the AI model providers that generate it and to the law where you publish it.")}</Li>
        <Li>{tr("You give us permission to store and process your uploads and results only to run the service for you (making frames, clips, checks and cuts).")}</Li>
        <Li>{tr("Only upload pictures, voices and music you have the right to use. Do not use anlim to make content that depicts real people without their consent, sexual content involving minors, content that harasses or deceives people, or anything illegal. We may remove such content and close accounts that make it.")}</Li>
        <Li>{tr("When you upload a photo or video of a person, you confirm that they are you or agreed that you may use their likeness; anlim keeps that confirmation with the file.")}</Li>
        <Li>{tr("Before an image, clip or sound is made, anlim checks the words and pictures it would use. Requests for sexual content or nudity, real public figures in photoreal pictures or video, real people shown in a sexual, humiliating or deceptive way, hate, graphic gore, self-harm or harassment are refused, and nothing is charged for them.")}</Li>
        <Li>{tr("Label AI-made video where the platform you publish on asks you to.")}</Li>
        <H>{tr("Connected accounts")}</H>
        <P>{tr("If you connect your ElevenLabs account, anlim uses your API key only to make the audio you ask for. You can disconnect at any time; that deletes the key. Your use of ElevenLabs is also under ElevenLabs' own terms.")}</P>
        <H>{tr("The service")}</H>
        <Li>{tr("AI models can produce mistakes. The anlim check helps but cannot catch everything; look at your clips before you publish them.")}</Li>
        <Li>{tr("We work to keep anlim available but cannot promise it will always be. We may change features and prices; price changes for plans apply from your next renewal, with notice.")}</Li>
        <Li>{tr("To the extent the law allows, our liability for any claim is limited to what you paid us in the 12 months before it.")}</Li>
        <H>{tr("Contact")}</H>
        <P>{tr("Questions about these terms: {v0}.", { v0: contact() })}</P>
      </Doc>
    </PublicFrame>
  );
}
