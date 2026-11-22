// Help & contact (2026-11-19): short answers to what creators ask, and how to reach a person. @anlim
import { Doc, H, Li, P, PublicFrame } from "../components/PublicFrame";
import { contact } from "./terms";

export default function Support() {
  return (
    <PublicFrame>
      <Doc title="Help & contact">
        <H>A clip didn't come out right</H>
        <P>Open it in Review: the anlim check lists what it saw. Render it again if it is not what you wanted. Every clip is charged when it is made, because the video model is paid for every render. If a clip is unusable (a broken body, an object that changes, the wrong action), open it in Review and choose Reject: say what is wrong and when. We look at every rejected clip within a few days. If we can see the problem, the credits come back to you; if we cannot, we tell you why and the charge stands.</P>
        <H>My characters look different from shot to shot</H>
        <P>Give each character a clear, front-on reference picture in Cast & places, and start each shot from a frame anlim made in your location (New setup), not from a loose upload.</P>
        <H>Why is my clip watermarked?</H>
        <P>Free accounts get watermarked clips and cuts. Buy credits or a plan and everything you make plays without it, old clips included.</P>
        <H>How do I cancel my plan?</H>
        <P>Credits & plan › Manage plan. Cancelling stops the next renewal; you keep your credits until then.</P>
        <H>How do I delete my account?</H>
        <P>Account › Delete account. It removes everything and cannot be undone, so download what you want to keep first.</P>
        <H>Use anlim from Claude, ChatGPT or another AI tool</H>
        <P>anlim works as a connector (an MCP server), so you can ask your AI assistant to make an image or a clip, check on it, list your projects or see your credits. Making images and clips from chat needs a paid account and uses your credits, as in the app (at most 5 every 10 minutes). The address is https://mcp.anlim.ai/mcp.</P>
        <Li>Claude: Customize › Connectors › + Add › Add custom connector. Name it anlim, paste the address, Add, then Connect and sign in to anlim.</Li>
        <Li>ChatGPT (web): Plugins › + › Add custom MCP server. Name it anlim, paste the address, choose OAuth, then sign in to anlim. ChatGPT lets only some plans use tools that make things (Business and Enterprise); on other plans it may only read your projects and clips.</Li>
        <Li>Other tools (Claude Code, Cursor, any MCP client): add a remote MCP server with the same address; the tool opens anlim's sign-in.</Li>
        <P>When the tool asks to connect, anlim shows what it may do; choose Approve. To disconnect, remove the connector in the tool.</P>
        <H>Contact</H>
        <P>Write to {contact()}. If you saw an error with a reference code, include it.</P>
      </Doc>
    </PublicFrame>
  );
}
