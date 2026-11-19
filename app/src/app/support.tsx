// Help & contact (2026-11-19): short answers to what creators ask, and how to reach a person. @anlim
import { Doc, H, P, PublicFrame } from "../components/PublicFrame";
import { contact } from "./terms";

export default function Support() {
  return (
    <PublicFrame>
      <Doc title="Help & contact">
        <H>A clip didn't come out right</H>
        <P>Open it in Review: the anlim check lists what it saw. Reject it and render again; a clip that fails the check costs nothing, and rejecting one it flagged gives the credits back.</P>
        <H>My characters look different from shot to shot</H>
        <P>Give each character a clear, front-on reference picture in Cast & places, and start each shot from a frame anlim made in your location (New setup), not from a loose upload.</P>
        <H>Why is my clip watermarked?</H>
        <P>Free accounts get watermarked clips and cuts. Buy credits or a plan and everything you make plays without it, old clips included.</P>
        <H>How do I cancel my plan?</H>
        <P>Credits & plan › Manage plan. Cancelling stops the next renewal; you keep your credits until then.</P>
        <H>How do I delete my account?</H>
        <P>Account › Delete account. It removes everything and cannot be undone, so download what you want to keep first.</P>
        <H>Contact</H>
        <P>Write to {contact()}. If you saw an error with a reference code, include it.</P>
      </Doc>
    </PublicFrame>
  );
}
