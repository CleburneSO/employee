# Employee Portal (GitHub Pages + Supabase)

A free/low-cost employee portal:

- **Logins** for every employee (invite-only, no public sign-up)
- **14-day pay-period timesheets** laid out like the Deputies Daily Report: time in/out and an explanation for each day, plus vacation, holiday, sick, traffic overtime and K9 hours, all with a **drawn + typed electronic signature**
- **Special duties you assign** (K9, DEA, Supervisor, grant overtime, …): each shows up only on the timesheets of the people you tick, gets highlighted when hours are entered, and is flagged at the top of the printout and in the approval list
- **Prints like the paper form**, one letter-size page per deputy, with the signature on the signature line
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
- *My Timesheets:* a day can have more than one block of time (**+ Add time** under the date), e.g. 07:00–19:00 regular and 19:00–21:00 Traffic OT. A block's type can be Regular or one of the person's special duties; those hours go on that duty's line instead of Hours Worked, and the line fills itself in. Overlapping blocks are caught. Pick the pay period, enter time in/out (overnight shifts are handled) and any explanation for each day, fill in vacation / holiday / sick / traffic OT / K9 hours, sign, type their name, check the box, submit. Totals are figured automatically (and re-checked by the database). They can resubmit (with a new signature) until it's approved. If a manager sends it back, the note shows at the top.
- *Time Off:* pick type and dates, submit. They can cancel while it's still pending.

**Calendar (everyone; the first tab)**
- **Announcements** and **Training announcements** at the top (managers post, pin, set "show until", edit or delete).
- A month **calendar**. Deputies see only **their own** events (the ones they're tagged on) plus anything marked **Show to everyone**; this is enforced by the database. Managers see all events and can switch to **Just mine**. When adding an event, managers tag deputies (**Select all** / **Clear** helpers) or tick **Show to everyone**. Your own events are outlined in red. On a phone, tap a day to see its events.
- **Coming up**: the next 45 days as a list.

**Off-Duty Jobs (everyone)**
- Managers post jobs (when, where, pay, number of spots, details).
- Deputies **request** a job (with an optional note). Managers **approve** or **decline**. A job can't be over-filled. Everyone sees who's approved. Deputies can withdraw, and a manager can undo an approval.
- Set a job to **Closed** to stop new requests, or **Cancelled** to keep it on record.

**Case Numbers (everyone)**
- Fill in Date, INTS, Victim/Defendant, A – I/O and Charge (details can be added later) and click **Reserve next case number**. The database hands out the next number (e.g. `202609230934` = reserved 9/23/2026, count 0934), so two people can never get the same one. The count runs all year and restarts at 0001 each January.
- The log shows 30 numbers per page, newest first, with search by case #, name, charge or initials. **Print log** prints 30 per page like the paper sheet.
- You can edit details on numbers you reserved; managers can edit any. Mistakes are **voided** with a reason — numbers are never deleted or reused. Only managers can restore a voided number.
- **Going live:** a manager sets **Next count** under Case number settings to one more than the last number used on paper (e.g. last used 0933 → enter 934).

**Managers**
- *Approvals:* review pending timesheets and time off, approve or send back / deny with a note. Open any timesheet and click **Print / Save PDF** for a paper copy.
- *Payroll:* pick a pay period and **Print all timesheets** (one page per deputy), or download a CSV (one row per person, or one row per day).
- *Team:* edit names and roles, **Deactivate** people who leave (they're locked out immediately; their records are kept and still searchable; don't delete them in Supabase), and tick which **special duties** each person has. Below that, manage the duty list: short name (K9), the line printed on the timesheet, the small-print note, optional **auto hours** pre-filled each pay period, **Everyone** (show on all timesheets), and **Active** (turn off to retire a duty; old timesheets keep it). It starts with Traffic OT, K9, DEA and Supervisor. Rename or edit them to match your wording.

## Good to know

- **Cost:** GitHub Pages is free. Supabase's free tier covers a small team, but free projects **pause after about a week with no activity** — upgrade to the paid plan if people will rely on it daily and you don't want that risk.
- **Emails (required before inviting deputies):** Supabase's built-in email sender only delivers to members of your Supabase team, about 2 per hour, so invites to deputies fail until you connect your own sender under **Authentication → Emails → SMTP Settings** (e.g. Resend or your county email). Branded invite and password-reset emails are in `email-templates.html`: paste them into **Authentication → Emails → Templates**.
- **E-signatures:** each timesheet stores the drawn signature image, typed name, a certification statement, and a server timestamp, and can't be altered after submission except by the employee re-signing. That covers what's typically expected for e-signatures under the U.S. ESIGN Act, but I'm not a lawyer — check your state's rules on timekeeping records and how long you must keep them.
- **Backups:** export your tables from Supabase periodically (Table Editor → Export to CSV), especially on the free plan.
- **Customizing:** time-off types live in both `schema.sql` (the `check` list) and `app.js` (`TIME_OFF_TYPES`) — change both together. Pay periods are set in `config.js` (`PAY_PERIOD_START` = the first day of any pay period, `PAY_PERIOD_DAYS` = 14). The printed header text is `COMPANY_NAME` and `REPORT_TITLE` in `config.js`.
- **Upgrading from the first version:** run the new `schema.sql` again in the SQL Editor. It keeps your data and adds the new columns.
- **Total Hours To Be Paid** = hours worked + vacation + holiday + sick + all special-duty hours. If payroll counts any of those differently, change the `total_paid_hours` line in `schema.sql` and the `paid` line in `app.js`.

## Inviting from the site (one-time setup)

Managers can invite people from the **Team** tab (name, email, role → **Send invite**). This needs a small function in Supabase, because sending invites requires Supabase's secret key, which must never be in the website:

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly **`invite-user`**.
3. Delete the sample code, paste in all of `supabase-invite-function.ts`, and click **Deploy**.
4. Turn **off** its "Verify JWT" / "Enforce JWT verification" setting. The function checks for itself that the caller is a signed-in, active manager, and the built-in check can wrongly reject logins on newer projects.

The function only works for signed-in, active managers. The person's name is saved to their profile and can be used in the invite email as `{{ .Data.full_name }}` (the template in `email-templates.html` already does this). You can still invite from the Supabase dashboard too; those invites just won't include a name.

## Email alerts (one-time setup)

The site emails people when something involves them:

| When | Who gets it |
|---|---|
| Off-duty request approved / declined | That deputy |
| Someone requests an off-duty job | Managers |
| New off-duty job posted ("Email everyone" box, on by default) | Everyone |
| Added to a court date / training / event | Those deputies |
| An event they're on changes time or place, or is deleted | Those deputies |
| New announcement ("Also email this to everyone" box, off by default) | Everyone |
| Time off approved / denied | That employee |
| Timesheet sent back | That employee |

Setup (uses your Resend account, with ccsoportal.com verified):
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor** → name it **`notify`** → paste all of `supabase-notify-function.ts` → **Deploy**, then turn **off** its "Verify JWT" setting (the function checks who's calling itself).
2. Supabase → **Edge Functions** → **Secrets** → add:
   - `RESEND_API_KEY`: a Resend API key with Sending access (you can reuse the one from SMTP)
   - `MAIL_FROM`: `Cleburne County Sheriff's Office <noreply@ccsoportal.com>`
   - `SITE_URL`: `https://ccsoportal.com/`

If alerts aren't set up, everything still saves; the site shows a one-time note that the email couldn't be sent. Deactivated people never get emails.
