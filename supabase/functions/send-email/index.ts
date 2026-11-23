// SFR event calendar: sends Supabase Auth emails (sign-in links) from contact@swissfoodresearch.ch
// through Microsoft Graph. Called by the Supabase "Send Email" auth hook.
//
// Secrets: SEND_EMAIL_HOOK_SECRET (v1,whsec_... from the hook settings), MS_TENANT_ID,
// MS_CLIENT_ID, MS_CLIENT_SECRET (the "SFR Events calendar" app). Exchange limits the app to
// sending from contact@ only (RBAC for Applications); the app has no Mail.Send grant in Entra.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "npm:standardwebhooks@1.0.0";

const FROM = Deno.env.get("MAIL_FROM") ?? "contact@swissfoodresearch.ch";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

let token: { value: string; expires: number } | null = null;

async function graphToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const r = await fetch(`https://login.microsoftonline.com/${Deno.env.get("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("MS_CLIENT_ID")!,
      client_secret: Deno.env.get("MS_CLIENT_SECRET")!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${body.error ?? ""}`);
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function signInEmail(link: string, code: string): { subject: string; html: string } {
  const subject = "Your sign-in link for Swiss Food Research events";
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#F8F9FF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FF;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:8px;font-family:'Funnel Sans',Arial,Helvetica,sans-serif;color:#0A0E1F;">
<tr><td style="background:#0A0E1F;border-radius:8px 8px 0 0;padding:20px 28px;color:#FFFFFF;font-size:18px;font-weight:700;">Swiss Food Research</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55;">
<p style="margin:0 0 16px;">Hello,</p>
<p style="margin:0 0 24px;">Use the button below to sign in to the Swiss Food Research event calendar and open the presentations you have access to.</p>
<p style="margin:0 0 24px;"><a href="${esc(link)}" style="display:inline-block;background:#1F3F6E;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px;">Sign in</a></p>
<p style="margin:0 0 8px;">If the button does not work, enter this code on the sign-in page:</p>
<p style="margin:0 0 24px;font-size:22px;font-weight:700;letter-spacing:4px;">${esc(code)}</p>
<p style="margin:0 0 16px;color:#4A5568;font-size:13px;">The link and the code work once and expire after one hour. If you did not ask to sign in, you can ignore this email.</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #E2E8F0;font-size:12px;color:#4A5568;">Swiss Food Research &middot; ${esc(FROM)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}

async function send(to: string, subject: string, html: string): Promise<void> {
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (r.status !== 202) throw new Error(`sendMail ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const payload = await req.text();
  let data: { user: { email: string }; email_data: Record<string, string> };
  try {
    const secret = (Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "").replace("v1,whsec_", "");
    data = new Webhook(secret).verify(payload, Object.fromEntries(req.headers)) as typeof data;
  } catch (_e) {
    return Response.json({ error: { http_code: 401, message: "invalid signature" } }, { status: 401 });
  }

  const { user, email_data: e } = data;
  try {
    const link = `${SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(e.token_hash)}` +
      `&type=${encodeURIComponent(e.email_action_type)}&redirect_to=${encodeURIComponent(e.redirect_to || e.site_url)}`;
    const { subject, html } = signInEmail(link, e.token);
    await send(user.email, subject, html);
    return Response.json({});
  } catch (err) {
    console.error("send-email failed", e?.email_action_type, (err as Error).message);
    return Response.json(
      { error: { http_code: 500, message: "The sign-in email could not be sent. Please try again later." } },
      { status: 500 },
    );
  }
});
