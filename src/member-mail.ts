import { recordActivity } from "./activity.js";

// Member mail (Mission Control): magic-link email rides the mail
// account already in the stack (Resend). The sending key belongs
// to the DOOR's own environment (RESEND_API_KEY in the door
// service env), never to the repo and never to a member. When no
// mailer is configured the door says so honestly (mailDelivered
// false) and the operator path takes over: `sam members link
// <email>` mints a link the operator delivers by hand. A live link
// is NEVER written to disk by this module - the only copies are
// the email itself and the hash in the members store.

export interface MagicLinkMailResult { delivered: boolean; reason: string }

export function memberAppBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SAM_MEMBER_APP_URL ?? "").trim().replace(/\/+$/, "");
}
export function magicLinkUrl(rawToken: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = memberAppBase(env);
  return base ? base + "/auth/verify?token=" + rawToken : "";
}

export async function sendMagicLinkEmail(root: string, opts: { to: string; rawToken: string; env?: NodeJS.ProcessEnv }): Promise<MagicLinkMailResult> {
  const env = opts.env ?? process.env;
  const link = magicLinkUrl(opts.rawToken, env);
  if (!link) {
    recordActivity(root, "sam", "member-mail-skipped", "A sign-in link was requested but no app address is configured (SAM_MEMBER_APP_URL); the operator path delivers it");
    return { delivered: false, reason: "no-app-url" };
  }
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) {
    recordActivity(root, "sam", "member-mail-skipped", "A sign-in link was requested but no mailer is configured on the door (RESEND_API_KEY); the operator path delivers it");
    return { delivered: false, reason: "no-mailer" };
  }
  const from = (env.SAM_MEMBER_MAIL_FROM ?? "SAM <sam@secondshift.site>").trim();
  const subject = "Your SAM sign-in link";
  const text = [
    "Hello,",
    "",
    "Here is your sign-in link for SAM Mission Control:",
    "",
    link,
    "",
    "It works once and expires in 30 minutes. If you did not ask for it, ignore this email - nothing happens without the link.",
    "",
    "SAM, the AI assistant for the rest of us.",
  ].join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject, text }),
    });
    if (!res.ok) {
      recordActivity(root, "sam", "member-mail-failed", "The sign-in email was refused by the mailer (HTTP " + res.status + "); the operator path can deliver the link");
      return { delivered: false, reason: "mailer-refused-" + res.status };
    }
    recordActivity(root, "sam", "member-mail-sent", "A sign-in link email was sent");
    return { delivered: true, reason: "sent" };
  } catch {
    recordActivity(root, "sam", "member-mail-failed", "The sign-in email could not be sent (mailer unreachable); the operator path can deliver the link");
    return { delivered: false, reason: "mailer-unreachable" };
  }
}
