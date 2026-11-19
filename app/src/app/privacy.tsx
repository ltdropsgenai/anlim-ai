// Privacy policy (DRAFT, 2026-11-19): lists exactly what the app stores and which services it sends data to, from the
// code as it is today. To be reviewed by a lawyer before launch. @anlim
import { Doc, H, Li, P, PublicFrame } from "../components/PublicFrame";
import { LAST_UPDATED, OPERATOR } from "../lib/legal";
import { contact, DraftNote } from "./terms";

export default function Privacy() {
  return (
    <PublicFrame>
      <Doc title="Privacy policy">
        <DraftNote />
        <P>Last updated {LAST_UPDATED}. This explains what anlim.ai ({OPERATOR}) keeps about you, why, and who else handles it.</P>
        <H>What we keep</H>
        <Li>Your account: email address, password (stored hashed by our sign-in service), and the date you joined.</Li>
        <Li>What you make and upload: series, scenes, shots, character and place pictures, frames, clips, cuts, music and audio, and your decisions on clips.</Li>
        <Li>Credits and payments: your balance, plan and payment history. Card details are held by Stripe, never by us.</Li>
        <Li>If you connect ElevenLabs: your API key, stored encrypted, and the last four characters to show you which key it is.</Li>
        <Li>If phone checks are switched on: your phone number, kept by our sign-in service, and a one-way hash of it so free credits go to one number once.</Li>
        <Li>A one-way hash of your email address, kept even after you delete your account, so the free starter credits cannot be claimed again with the same address. It cannot be turned back into your email.</Li>
        <H>Who handles it for us</H>
        <Li>Supabase: database, sign-in and file storage.</Li>
        <Li>Stripe: payments and plans.</Li>
        <Li>fal.ai and the AI models it runs (video: Kling, MiniMax; images: Nano Banana, GPT Image): your shot text and frames are sent to make frames and clips.</Li>
        <Li>Anthropic: frames from your clips are sent to Claude for the anlim check.</Li>
        <Li>ElevenLabs: only if you connect your account; the text and settings for audio you ask for.</Li>
        <Li>Our hosting providers (the website and the background workers that make your clips), and on the website, Google Fonts for typefaces.</Li>
        <P>We do not sell your data and do not use it for advertising.</P>
        <H>How long we keep it</H>
        <P>Until you delete it or your account. Deleting your account (Account › Delete account) removes your work, files, connections and account straight away, except the email hash above and payment records Stripe must keep by law.</P>
        <H>Your choices</H>
        <Li>Download your work from Assets at any time.</Li>
        <Li>Delete single items in Assets, scenes and series in the Workspace, or everything by deleting your account.</Li>
        <Li>Ask us what we hold about you or to correct it: {contact()}.</Li>
      </Doc>
    </PublicFrame>
  );
}
