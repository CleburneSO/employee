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
- *My Timesheets:* pick the pay period, enter time in/out (overnight shifts are handled) and any explanation for each day, fill in vacation / holiday / sick / traffic OT / K9 hours, sign, type their name, check the box, submit. Totals are figured automatically (and re-checked by the database). They can resubmit (with a new signature) until it's approved. If a manager sends it back, the note shows at the top.
- *Time Off:* pick type and dates, submit. They can cancel while it's still pending.

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
- **Emails:** Supabase's built-in email sender has a low hourly limit meant for testing. If invites or reset emails stop arriving, add your own SMTP (e.g. Resend, SendGrid, or your email provider) under **Authentication → SMTP Settings**.
- **E-signatures:** each timesheet stores the drawn signature image, typed name, a certification statement, and a server timestamp, and can't be altered after submission except by the employee re-signing. That covers what's typically expected for e-signatures under the U.S. ESIGN Act, but I'm not a lawyer — check your state's rules on timekeeping records and how long you must keep them.
- **Backups:** export your tables from Supabase periodically (Table Editor → Export to CSV), especially on the free plan.
- **Customizing:** time-off types live in both `schema.sql` (the `check` list) and `app.js` (`TIME_OFF_TYPES`) — change both together. Pay periods are set in `config.js` (`PAY_PERIOD_START` = the first day of any pay period, `PAY_PERIOD_DAYS` = 14). The printed header text is `COMPANY_NAME` and `REPORT_TITLE` in `config.js`.
- **Upgrading from the first version:** run the new `schema.sql` again in the SQL Editor. It keeps your data and adds the new columns.
- **Total Hours To Be Paid** = hours worked + vacation + holiday + sick + all special-duty hours. If payroll counts any of those differently, change the `total_paid_hours` line in `schema.sql` and the `paid` line in `app.js`.
