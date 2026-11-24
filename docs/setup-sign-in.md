# Sign-in setup (one-off)

Two ways to sign in, both under the same access rules (staff, current member domain, or
registered participant of the event):

* **Sign in with Microsoft**: one click for anyone with a Microsoft 365 work account.
* **Email me a sign-in link**: for everyone else; the email comes from contact@swissfoodresearch.ch.

Project: Supabase `ig-wiki` (`iudsjtrdtncqqhswcnfu`). Already in place: the account gate
(`public.events_before_user_created`), the Edge Functions `deck` and `send-email`, and the app
"SFR Events calendar" (reads team2 decks; secrets `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`).

## A. Entra: a separate app for signing in

1. Entra > App registrations > **New registration**
   * Name: `SFR Events sign-in`
   * Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**
   * Redirect URI: platform **Web**, `https://iudsjtrdtncqqhswcnfu.supabase.co/auth/v1/callback`
2. Note the **Application (client) ID**.
3. Certificates & secrets > **New client secret**, 24 months. Copy the **Value** (not the Secret ID).
4. **Manifest**: back up the JSON, then replace the `optionalClaims` block with:
   ```json
   "optionalClaims": {
     "idToken": [
       { "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] },
       { "name": "email", "source": null, "essential": false, "additionalProperties": [] }
     ],
     "accessToken": [
       { "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] }
     ],
     "saml2Token": []
   },
   ```
   Save. `xms_edov` tells Supabase whether Microsoft has verified the email address. Unverified
   addresses never get access to decks.
5. API permissions: Microsoft Graph, **Delegated**: `openid`, `email`, `profile` (plus the default
   `User.Read`). No admin consent needed. Do **not** give this app any application permissions.

## B. Supabase: Microsoft provider

Authentication > Sign In / Providers > **Azure**: enable, then enter
* Application (client) ID: from A2
* Secret value: from A3
* Azure Tenant URL: `https://login.microsoftonline.com/organizations` (work accounts only)

Also under Sign In / Providers > **Email**: enabled, "Allow new users to sign up" on (the account
gate decides who), "Confirm email" on.

## C. Exchange Online: let the calendar app send from contact@ only

Do **not** add `Mail.Send` to the app in Entra: an Entra grant would let it send as anyone and
overrides the restriction below. Run as an Exchange administrator:

```powershell
Install-Module ExchangeOnlineManagement   # once
Connect-ExchangeOnline -UserPrincipalName <admin>@swissfoodresearch.ch

# APP-ID  = Application (client) ID of "SFR Events calendar"
# OBJ-ID  = Object ID of "SFR Events calendar" under Entra > Enterprise applications
#           (not the Object ID on the App registrations page)
New-ServicePrincipal -AppId APP-ID -ObjectId OBJ-ID -DisplayName "SFR Events calendar"

New-ManagementScope -Name "SFR contact mailbox only" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'contact@swissfoodresearch.ch'"

New-ManagementRoleAssignment -Name "SFR Events calendar - send as contact" `
  -App APP-ID -Role "Application Mail.Send" -CustomResourceScope "SFR contact mailbox only"

# Check: contact@ in scope, anyone else not
Test-ServicePrincipalAuthorization -Identity APP-ID -Resource contact@swissfoodresearch.ch
Test-ServicePrincipalAuthorization -Identity APP-ID -Resource <your own address>
```

The first test should show `InScope : True`, the second `False`. Exchange can take up to an
hour or two before the permission works.

## D. Supabase: hooks, secret and addresses

1. Authentication > **Hooks** > *Before User Created*: type Postgres, schema `public`,
   function `events_before_user_created`. Enable.
2. Authentication > **Hooks** > *Send Email*: type HTTPS,
   URL `https://iudsjtrdtncqqhswcnfu.supabase.co/functions/v1/send-email`.
   Click **Generate secret**, copy it (starts with `v1,whsec_`), enable the hook.
3. Edge Functions > **Secrets**: add `SEND_EMAIL_HOOK_SECRET` with that value.
4. Authentication > **URL Configuration**
   * Site URL: `https://hub.swissfoodresearch.ch/`
   * Redirect URLs: `https://foodinnovation.github.io/sfr-events/**`,
     `https://hub.swissfoodresearch.ch/**`, `http://localhost:8000/**`

## E. Test

Run the "Health check" workflow, then request a sign-in link for a staff address. The email
should arrive from contact@swissfoodresearch.ch within a minute.

## Later

* Publisher verification for "SFR Events sign-in" (needs a Microsoft AI Cloud Partner Program
  ID). Many organisations only let staff approve apps from verified publishers; until then some
  members will see "Admin approval required" and can use the email link instead.
* Both client secrets expire after 24 months. Put the renewal in the calendar.
