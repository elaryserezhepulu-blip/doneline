# Doneline — private notes & to-do board

A personal to-do board that only you can sign in to, a public landing page that search engines can index, and Gmail reminders.

## Run locally
```
cd Desktop\doneline
npm install
npm start          → http://localhost:7070
```
First visit `/login`: enter the **6-digit setup code printed in the console**, your Gmail and a password. After that nobody else can register.

## Turn on real Gmail sending
1. Google account → Security → turn on **2-Step Verification**.
2. Open https://myaccount.google.com/apppasswords → create an app password ("Doneline").
3. Copy `.env.example` to `.env` and set:
   ```
   GMAIL_USER=you@gmail.com
   GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
   ```
4. Restart. Settings → **Send test email**.

Without these, emails are saved in Settings → *Recent emails* (preview mode) instead of being sent.

## Emails it sends
- **Reminder** at a task's time (or 5 min–1 day before; choose in task details). Goes to you + any @people on the task.
- **Morning digest** (default 08:00) of overdue + today's tasks. People with "digest" ticked get only their own tasks.
- Your emails have **✓ Done** and **→ Tomorrow** buttons that work without logging in (signed links + confirm page).

## Put it online (so people can find it in Google)
Any Node 22.5+ host with a persistent disk works. Example with **Render**:
1. Push this folder to a GitHub repo (`.env` and `data/` are git-ignored).
2. Render → New → Blueprint → pick the repo (uses `render.yaml`), or New Web Service with `npm install` / `npm start`.
3. Set env vars: `BASE_URL=https://your-name.onrender.com`, `SITE_NAME`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SETUP_CODE` (pick any 6 digits), `DATA_DIR=/var/data`.
4. Open `/login`, use your SETUP_CODE to claim it.
5. Google Search Console → add your URL → submit `https://…/sitemap.xml`. Indexing takes a few days.
   Put your name in `SITE_NAME` / `SITE_TAGLINE` if you want people to find it by searching your name.

Only `/` is indexable; `/app`, `/api`, `/login` and email links are blocked from search engines and need your password.

## Quick-add language
`Call mom tomorrow 7pm #family !2 @ali` · `Pay rent every month !!!` · `Gym weekdays 18:30` · `Essay 15.12 23:59 #uni` · `Stretch in 2 hours` · `завтра в 9:00 позвонить`

Keys: `N` new · `/` search · `J/K` move · `X` done · `T/M/W/S` today/tomorrow/next week/someday · `P` priority · `Del` delete · `U` undo · `1–5` views · `?` help.
