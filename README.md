# Employee Portal (GitHub Pages + Supabase)

A free/low-cost employee portal:

- **Logins** for every employee (invite-only, no public sign-up)
- **Weekly timesheets** with time in/out, breaks, auto-totals, and a **drawn + typed electronic signature**
- **Time-off requests** that managers approve or deny, with an optional note
- **Manager tools:** approval queue, printable signed timesheets, CSV export for payroll, team/role management
- Signed timesheets are locked once approved, and the database (not just the web page) enforces who can see and change what

## Files

| File | What it is |
|---|---|
| `index.html` | The page GitHub Pages serves |
| `app.js` | All the app logic |
| `style.css` | Styling |
| `config.js` | Your Supabase URL + key (edit this) |
| `schema.sql` | Database tables, security rules — run in Supabase |

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project at supabase.com (free tier is fine).
2. **SQL Editor → New query**, paste all of `schema.sql`, click **Run**.
3. **Authentication → Sign In / Providers** (or Auth settings): turn **off** "Allow new users to sign up". Keep **Email** enabled. Invites still work with sign-up off, so only people you invite can get in.
4. **Project Settings → API**: copy the **Project URL** and the **anon / publishable key** into `config.js`. Also set `COMPANY_NAME`.
   Never use the `service_role` / secret key in this site.

### 2. GitHub Pages
1. Create a repo and upload these files to the root.
2. **Settings → Pages → Deploy from a branch → `main` / root**.
3. Note your URL, e.g. `https://yourname.github.io/employee-portal/`.

### 3. Connect them
In Supabase **Authentication → URL Configuration**:
- **Site URL:** your GitHub Pages URL (with the trailing slash)
- **Redirect URLs:** add the same URL

### 4. Make yourself the manager
1. **Authentication → Users → Invite user** → your own email.
2. Click the link in the email → set a password → enter your name.
3. In the **SQL Editor** run:
   ```sql
   update public.profiles set role = 'manager' where email = 'you@example.com';
   ```
4. Refresh the site — you'll see the **Approvals** and **Team** tabs.

### 5. Add employees
Invite each person from **Authentication → Users → Invite user**. They set a password from the email and they're in. You can promote other managers from the **Team** tab.

## How it works

**Employees**
- *My Timesheets:* pick the week, enter in/out times and breaks, sign in the box, type their name, check the certification, submit. They can resubmit (with a new signature) until it's approved. If a manager sends it back, the note shows at the top.
- *Time Off:* pick type and dates, submit. They can cancel while it's still pending.

**Managers**
- *Approvals:* review pending timesheets and time off, approve or send back / deny with a note. Open any timesheet and click **Print / Save PDF** for a paper copy.
- *Export:* download a CSV of approved timesheets for a date range to hand to payroll.
- *Team:* edit names and roles.

## Good to know

- **Cost:** GitHub Pages is free. Supabase's free tier covers a small team, but free projects **pause after about a week with no activity** — upgrade to the paid plan if people will rely on it daily and you don't want that risk.
- **Emails:** Supabase's built-in email sender has a low hourly limit meant for testing. If invites or reset emails stop arriving, add your own SMTP (e.g. Resend, SendGrid, or your email provider) under **Authentication → SMTP Settings**.
- **E-signatures:** each timesheet stores the drawn signature image, typed name, a certification statement, and a server timestamp, and can't be altered after submission except by the employee re-signing. That covers what's typically expected for e-signatures under the U.S. ESIGN Act, but I'm not a lawyer — check your state's rules on timekeeping records and how long you must keep them.
- **Backups:** export your tables from Supabase periodically (Table Editor → Export to CSV), especially on the free plan.
- **Customizing:** time-off types live in both `schema.sql` (the `check` list) and `app.js` (`TIME_OFF_TYPES`) — change both together. Weeks start on Monday (`mondayOf` in `app.js`).
