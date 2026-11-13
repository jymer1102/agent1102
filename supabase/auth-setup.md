# Account security setup (Supabase dashboard)

The app's code can't change these settings. They live in your Supabase project, and the 6-digit code boxes only work when they are right. (Supabase moves menu items around now and then. If a name below isn't where it says, search the dashboard for it.)

## 1. Run the SQL (once)

Supabase dashboard -> **SQL Editor** -> paste `supabase/schema.sql` -> **Run**. It is safe to run again. This adds the `author` column to `chats` and fills it in for the chats you already have.

Until it has run, chats still save (without the missing column) and the server log says `WARNING: the chats table is missing a column`.

## 2. Make email codes 6 digits

**Authentication -> Sign In / Providers -> Email -> Email OTP Length -> `6`**, then Save.

Newer Supabase projects send **8-digit** codes by default. The app asks for 6 digits, so an 8-digit code can never be typed in. This one setting applies to every code below.

## 3. Put the code in the emails

**Authentication -> Email Templates.** The code is `{{ .Token }}`. Keep `{{ .ConfirmationURL }}` too, so the link in the same email keeps working.

| Template | Used for | Needs `{{ .Token }}`? |
|---|---|---|
| **Reauthentication** | changing your password in Settings | Yes (the default template already has it) |
| **Confirm signup** | confirming a new account | Yes, to confirm with a code |
| **Reset password** | "Forgot password?" | Yes, to reset with a code |
| Change email address | changing email | No: still a link |

Example for *Confirm signup* and *Reset password*:

```html
<h2>Your code</h2>
<p>Enter this 6-digit code in the app:</p>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
<p>Or <a href="{{ .ConfirmationURL }}">open this link instead</a>.</p>
```

Without the code in a template, the app still shows the code window, and the person can use the link in that email instead.

## 4. Check these too

- **Authentication -> Providers -> Email -> Secure password change** is on (a code is then required to change a password).
- **Email delivery.** Supabase's built-in email sender is only meant for testing and allows just a few emails per hour, so codes may not arrive. For real use add your own SMTP provider under **Authentication -> Emails -> SMTP Settings**.

## Banning and suspending people

**Authentication -> Users -> (the person) -> Ban user**, with a duration (for a suspension) or a very long one (for a ban). Unban the same way.

What the app does:

- Signing in (password, Discord or GitHub) or confirming with a code: refused, with "This account has been banned or suspended...".
- Someone already signed in: the server turns away their very next request, the page signs them out and shows the same message, and Supabase ends all of their sessions. A page that is just sitting open checks once a minute. In the worst case it takes about two minutes (the server remembers each person for up to a minute).

Supabase on its own only blocks *new* sign-ins and refreshes. A sign-in someone already has keeps working for up to an hour, which is why the app checks for itself.

## Phone numbers

The phone typed at sign-up is saved to **Authentication -> Users -> Phone** (the real `auth.users.phone` column), in international form (`+13145550123`).

- A number typed without a country code is treated as US/Canada (+1). Change this with the environment variable `DEFAULT_PHONE_COUNTRY_CODE` (for example `44`).
- A number that cannot be real is refused at sign-up. The field can be left blank.
- Each phone number can belong to **one account**. If another account already has it, Supabase refuses the save and the number stays only in the profile.
- The number is saved but **not marked confirmed**: nobody has proved it is theirs.
- People who signed up before this change get their number copied across the next time they sign in.
