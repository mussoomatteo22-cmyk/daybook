# Daybook

A personal planner for classes, appointments, work shifts and projects. Anyone can create an account with their email, and their planner is private to them and synced between phone and computer. Each person picks which emails they want in **Settings › Email**. Everything goes to the address they signed up with.

One codebase runs as:

| | What people download | Built with |
|---|---|---|
| **iPhone** (and iPad) | From the App Store or TestFlight | Capacitor (`ios/`) |
| **Mac** | `.dmg` | Tauri (`src-tauri/`) |
| **Windows** | `.msi` or `-setup.exe` | Tauri |
| **Linux** | `.AppImage` or `.deb` | Tauri |
| **Web** | Any browser, installable as an app | `web/` |

```
web/                        the app itself (plain HTML/JS, no build step)
  index.html                UI, sign-in, settings
  config.js                 your Supabase URL, anon key and site address   ← fill in
  vendor/supabase.js        bundled so the apps start without the internet
ios/                        Xcode project for iPhone (open ios/App/App.xcworkspace)
src-tauri/                  desktop app (Mac, Windows, Linux)
supabase/
  migrations/               database tables + privacy rules
  functions/send-reminders  every email Daybook sends
  functions/delete-account  "Delete account" button (the App Store requires it)
  email-templates/          sign-in / sign-up / reset emails with 6-digit codes
  schedule_reminders.sql    runs the email job every 5 minutes
.github/workflows/          builds every installer for you on GitHub
```

---

## Step 1 · Accounts and database (Supabase, free tier)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor › New query**: paste and run `supabase/migrations/001_daybook.sql`, then `002_classes.sql`.
3. **Project Settings › API**: copy the *Project URL* and *anon public* key into `web/config.js`. Also set `siteUrl` to where the web version will live (Step 4).
4. **Authentication › Sign In / Providers › Email**: keep it on and keep **Confirm email** on.
5. **Authentication › Emails › Templates**: the apps sign people in with a **6-digit code**, because a link in an email would open the browser instead of the app. Paste the matching file from `supabase/email-templates/` into each of these templates:
   - **Confirm signup**: `confirm-signup.html`
   - **Magic Link**: `magic-link.html`
   - **Reset Password**: `reset-password.html`
6. **Authentication › URL Configuration**: set *Site URL* to your web address and add it to *Redirect URLs*.

What people see:
- **Create account**: name, email and password, then the 6-digit code from their inbox.
- **Sign in**: email and password, or *Sign in with an email code*.
- **Forgot password?**: a code, then a new password.
- **Settings › Your data › Delete account**: erases everything.

## Step 2 · Email notifications (Resend)

1. Make a free account at [resend.com](https://resend.com), verify a domain you own, and create an API key.
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from this folder:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set RESEND_API_KEY=re_xxx FROM_EMAIL="Daybook <hello@yourdomain.com>" \
  CRON_SECRET=$(openssl rand -hex 24) APP_URL=https://your-daybook-site.com
supabase functions deploy send-reminders --no-verify-jwt
supabase functions deploy delete-account
```

3. Open `supabase/schedule_reminders.sql`, put in your project ref and the same `CRON_SECRET`, and run it in the SQL Editor.
4. **Recommended:** under **Authentication › Emails › SMTP Settings**, add Resend as the SMTP server (host `smtp.resend.com`, port 465, user `resend`, password = your API key). Supabase's built-in mailer only sends a few emails an hour, which isn't enough once real people sign up.

### What people can turn on (Settings › Email)

Each item below is its own switch. Everything uses the person's time zone.

- **Before it starts.** These use each item's own reminder time.
  - Events and appointments
  - Lectures and labs
  - Tests and quizzes
  - Work shifts
  - Project work sessions
- **Heads-up email.** One email at a time they choose, listing what's coming up. Each type can be Off, on the day, 1, 2 or 3 days before, or 1 week before:
  - Tests and quizzes
  - Assignments
  - Project to-dos and steps
  - Project deadlines
  - Overdue items (a separate switch)
- **Summaries:**
  - Daily summary at a chosen time.
  - Weekly summary on a chosen day and time. It covers the week ahead and can also include hours, wages and tips from the last 7 days.
- **Work:** a tip reminder after a shift ends, if tips haven't been logged.
- **Send a test.** A button that checks delivery straight away.

The phone and desktop apps also show **device notifications**. On iPhone, the next week of reminders is handed to iOS, so alerts arrive even when Daybook is closed.

## Step 3 · Desktop apps (Mac, Windows, Linux)

**Easiest: let GitHub build them.** You don't need to install anything.
1. Put this folder in a GitHub repository (it can be private).
2. Open **Actions › Build apps › Run workflow**.
3. After about 15 minutes, download from the bottom of the run page:
   - **Daybook-Mac**: `.dmg`
   - **Daybook-Windows**: `.msi` and `-setup.exe`
   - **Daybook-Linux**: `.AppImage` and `.deb`

**Or build on your own computer**, which needs [Rust](https://rustup.rs) and Node 20:
```bash
npm install
npm run desktop:dev      # try it in a window
npm run desktop:build    # makes the installer for the computer you're on
```

Unsigned apps install fine but show a warning the first time:
- **Mac:** right-click the app › *Open*.
- **Windows:** *More info* › *Run anyway*.

To remove the warning on Mac, add these repository secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`. The workflow then signs and notarizes it automatically. This needs an Apple Developer account. Windows signing needs a code-signing certificate.

## Step 4 · iPhone app

Apple only allows iPhone apps to be installed through the App Store, TestFlight, or straight from Xcode. All three need a Mac with Xcode.
- **Your own phone only:** the free Apple account is enough, but the app must be reinstalled every 7 days.
- **Other people, or longer than a week:** the [Apple Developer Program](https://developer.apple.com/programs/) is required ($99 USD/year).

**On a Mac:**
```bash
npm install
npx cap sync ios          # copies web/ into the Xcode project
npx cap open ios          # opens Xcode
```
1. In Xcode, select **App** › **Signing & Capabilities** › choose your Team. If `com.daybook.planner` is taken, change the bundle ID.
2. To put it on your own phone: plug in the iPhone and press ▶︎.
3. To share it: choose **Product › Archive**, then **Distribute App › App Store Connect**. The build appears in TestFlight, where you can invite testers by email or submit it to the App Store.

**Without a Mac:** the GitHub workflow builds the iPhone app on Apple hardware. Every run checks that it compiles. To have it upload to TestFlight automatically, add these repository secrets:

| Secret | Where it comes from |
|---|---|
| `APPLE_TEAM_ID` | developer.apple.com › Membership |
| `IOS_CERTIFICATE_P12`, `IOS_CERTIFICATE_PASSWORD` | An *Apple Distribution* certificate exported as .p12, then base64-encoded |
| `IOS_PROVISION_PROFILE`, `IOS_PROFILE_NAME` | An *App Store* provisioning profile for `com.daybook.planner`, base64-encoded, and its name |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | App Store Connect › Users and Access › Integrations › API key (App Manager role) |

Before submitting to the App Store, Apple will ask for:
- **A privacy policy URL and a support URL.** Any simple page works.
- **Screenshots.**
- **Sign-in details for the reviewer.** Create a test account for them.

Daybook already has the account deletion Apple requires (Settings › Your data).

## Step 5 · Web version (optional)

`web/` is a static site. Put it on Netlify (drag the folder onto app.netlify.com/drop), Vercel (`npx vercel web`), Cloudflare Pages or GitHub Pages. People can also install it from the browser:
- **iPhone:** Safari › Share › *Add to Home Screen*.
- **Android:** Chrome › *Install app*.
- **Computer:** the install icon in the address bar.

Try it locally with `npm run dev` and open http://localhost:5173.

## After you change the app

Edit files in `web/`, then:
- **iPhone:** run `npx cap sync ios`.
- **Desktop:** run the GitHub workflow again.

Bump `version` in `package.json` and `src-tauri/tauri.conf.json` for each release.

## How privacy works

- Every event, class, project and settings row has a `user_id`. Row-level security only lets the signed-in person read or change their own rows, so the public anon key in `config.js` is safe to ship.
- The email job and account deletion run on Supabase's servers with the private service key, which never reaches the app.
- Deleting an account removes all of that person's rows.
