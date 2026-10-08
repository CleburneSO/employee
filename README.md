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
| `schema.sql` | The whole database: tables, functions, triggers and security rules. Safe to re-run in Supabase. After changing the database in Supabase, use **Download database setup** and update this file |

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

### 4b. Make yourself the site owner
In the **SQL Editor** run (with the email you sign in with):
```sql
update public.profiles set is_owner = true where email = 'you@example.com';
```
The site owner is a manager who also:
- is the only person who can see the **Audit Log** tab (the database enforces this too)
- can **Download database setup** at the top of the Audit Log: every table, function and security rule as one `.sql` file, with no records
- can't be demoted or deactivated by other managers

The owner flag can only be set from the SQL Editor, never from the site.

### 5. Add employees
Invite each person from **Authentication → Users → Invite user**. They set a password from the email and they're in. You can promote other managers from the **Team** tab.

## How it works

**Employees**
- *My Timesheets:* a day can have more than one block of time (**+ Add time** under the date), e.g. 07:00–19:00 regular and 19:00–21:00 Traffic OT. A block's type can be Regular or one of the person's special duties; those hours go on that duty's line instead of Hours Worked, and the line fills itself in. Overlapping blocks are caught. Pick the pay period, enter time in/out (overnight shifts are handled) and any explanation for each day, fill in vacation / holiday / sick / traffic OT / K9 hours, sign, type their name, check the box, submit. Totals are figured automatically (and re-checked by the database). They can resubmit (with a new signature) until it's approved. If a manager sends it back, the note shows at the top.
- *Time Off & Comp* (just *Time Off* for people without comp time): the comp time balance at the top, then one form with three choices: **Request time off** (vacation or sick, dates, hours), **Use comp time** (dates and hours, showing what's left after) or **Log comp time earned** (day worked, hours worked, what for; credited at time and a half, so 2 hours worked = 3 comp hours once approved, rounded to the quarter hour). Each goes to the time-off approvers. They can cancel while it's still pending.

**Calendar (everyone; the first tab)**
- **Announcements** and **Training announcements** at the top (managers post, pin, set "show until", edit or delete).
- A month **calendar**. Deputies see only **their own** events (the ones they're tagged on) plus anything marked **Show to everyone**; this is enforced by the database. Managers see all events and can switch to **Just mine**. When adding an event, managers tag deputies (**Select all** / **Clear** helpers) or tick **Show to everyone**. Your own events are outlined in red. On a phone, tap a day to see its events.
- **Coming up**: the next 15 days as a list.
- **Off-duty jobs** show on the calendar (blue) while they still have open spots, so deputies can spot open work; tap one for the details and a link to request it. Pending requests don't count as filled. Once every spot is filled, or the job is closed or cancelled, it leaves the calendar, except for the deputies approved to work it.
- **Add to my calendar**: open any event and tap it to add it to the phone's or computer's calendar app (with its own reminder: 1 hour before, or 9 AM the day before for all-day events). On iPhone this uses the **`event-ics`** Edge Function: deploy `supabase-event-ics-function.ts` as `event-ics` with "Verify JWT" off (no secrets needed). The portal gets a 10-minute pass for that one event and opens the function's address, which Safari offers to add to Calendar.
- **My events**: anyone can tap **Add my event** (or tap a day → **Add my event this day**) for a personal event: dentist, day off, kid's game. Only that person sees it (not other deputies, not managers); it never sends email. The database enforces this.
- **Paid holidays**: add an event with type **Paid holiday** (hours default to 8). It shows on everyone's calendar, and when anyone opens a timesheet for that pay period, **Total Holiday Hours** and that day's explanation are filled in automatically (editable before signing). Timesheets already submitted aren't changed.

**Off-Duty Jobs (everyone)**
- Managers post jobs (when, where, pay, number of spots, details).
- Deputies **request** a job (with an optional note). Managers **approve** or **decline**. A job can't be over-filled. Everyone sees who's approved. Deputies can withdraw, and a manager can undo an approval.
- Set a job to **Closed** to stop new requests, or **Cancelled** to keep it on record.

**Case Numbers (everyone)**
- Fill in Date, INTS, Victim/Defendant, A – I/O and Charge (details can be added later) and click **Reserve next case number**. The database hands out the next number (e.g. `202609230934` = reserved 9/23/2026, count 0934), so two people can never get the same one. The count runs all year and restarts at 0001 each January.
- The log shows 30 numbers per page, newest first, with search by case #, name, charge or initials. **Print log** prints 30 per page like the paper sheet.
- You can edit details on numbers you reserved; managers can edit any. Mistakes are **voided** with a reason — numbers are never deleted or reused. Only managers can restore a voided number.
- **Going live:** a manager sets **Next count** under Case number settings to one more than the last number used on paper (e.g. last used 0933 → enter 934).

**Uniforms (Sheriff's Office)**
- Everyone has a **$500 uniform allowance** per year, resetting every **October 1** (unused money doesn't carry over). The amount is set in `uniform_allowance()` in `schema.sql`.
- *Uniforms* tab: the balance left this year, a request form with one line per Galls item (item # or link, description, size, quantity, price; the total adds up), and their requests with status (Pending → Approved → Ordered → Received, or Denied / Cancelled). A request can't be more than what's left (requests still waiting count against it); the database enforces this and works out the total itself.
- The time-off approvers (sheriff and chief deputy) get an email for each request and approve or deny it on *Approvals*. When approving they can change the amount to the actual invoice total, and later correct it on an approved order (**Update amount**, e.g. once the Galls invoice arrives; it can't exceed what the person has); that amount comes out of the allowance and the deputy gets an email.
- *Payroll & History → Uniform allowance*: everyone's balance (with **Adjust** for money already spent on paper, CSV download), approved orders still to **mark ordered** from Galls and **mark received**, and recent orders. Each order opens as a printable **Uniform / Equipment Order** form (Print / Save PDF).
- Turned off on the jail portal (`uniforms: false`).

**Managers**
- The manager pages are under the **Admin** tab (a drop-down on a computer, an "Admin" section in the ☰ menu on a phone): Approvals, Payroll & History, Team, and Audit Log for the site owner. Admin and Approvals show how many items are waiting.
- *Approvals:* only what's waiting: who **hasn't submitted a timesheet** (on the last day of a pay period, and after it until everyone's in), pending timesheets and time off. Approve or send back / deny with a note. Open any timesheet, time-off request or comp time entry and click **Print / Save PDF** for a paper copy (employees can print their own too).
- *Payroll & History:* comp time balances (and adjustments), payroll (pick a pay period and **Print all timesheets**, one page per deputy, or download a CSV), and the approved / denied history of timesheets and time off. Pick a person to see their full history.
- *Team:* edit names and roles, **Deactivate** people who leave (they're locked out immediately; their records are kept and still searchable; don't delete them in Supabase), and tick which **special duties** each person has. Below that, manage the duty list: short name (K9), the line printed on the timesheet, the small-print note, optional **auto hours** pre-filled each pay period, **Everyone** (show on all timesheets), and **Active** (turn off to retire a duty; old timesheets keep it). It starts with Traffic OT, K9, DEA and Supervisor. Rename or edit them to match your wording.

## Good to know

- **Cost:** GitHub Pages is free. Supabase's free tier covers a small team, but free projects **pause after about a week with no activity** — upgrade to the paid plan if people will rely on it daily and you don't want that risk.
- **Emails (required before inviting deputies):** Supabase's built-in email sender only delivers to members of your Supabase team, about 2 per hour, so invites to deputies fail until you connect your own sender under **Authentication → Emails → SMTP Settings** (e.g. Resend or your county email). Branded invite and password-reset emails are in `email-templates.html`: paste them into **Authentication → Emails → Templates**.
- **E-signatures:** each timesheet stores the drawn signature image, typed name, a certification statement, and a server timestamp, and can't be altered after submission except by the employee re-signing. That covers what's typically expected for e-signatures under the U.S. ESIGN Act, but I'm not a lawyer — check your state's rules on timekeeping records and how long you must keep them.
- **Backups:** export your tables from Supabase periodically (Table Editor → Export to CSV), especially on the free plan.
- **Customizing:** time-off types live in both `schema.sql` (the `check` list) and `app.js` (`TIME_OFF_TYPES`) — change both together. Pay periods are set in `config.js` (`FIRST_PAY_PERIOD` = the portal's first pay period, `PAY_PERIOD_DAYS` = 14); the timesheet reminder function has its own copy of both at the top of `supabase-timesheet-reminder-function.ts`, so change them there too. The printed header text is `COMPANY_NAME` and `REPORT_TITLE` in `config.js`.
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
| Someone requests uniforms / equipment | The time-off approvers (sheriff and chief deputy), once per request |
| Uniform order approved / denied | That person |
| Someone requests an off-duty job | The time-off approvers, e.g. the sheriff and chief deputy (once per request; again only if they withdraw and ask again) |
| New off-duty job posted ("Email everyone" box, on by default) | Everyone |
| Added to a court date / training / event | Those deputies |
| The afternoon before a court date / training / event they're tagged on | Those deputies |
| An event they're on changes time or place, or is deleted | Those deputies |
| New announcement ("Also email this to everyone" box, off by default) | Everyone |
| Someone requests time off or logs comp time | The time-off approvers (see below) |
| Time off approved / denied | That employee |
| Timesheet sent back | That employee |
| Last day of the pay period, timesheet not submitted | That person (one reminder) |

Setup (uses your Resend account, with ccsoportal.com verified):
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor** → name it **`notify`** → paste all of `supabase-notify-function.ts` → **Deploy**, then turn **off** its "Verify JWT" setting (the function checks who's calling itself).
2. Supabase → **Edge Functions** → **Secrets** → add:
   - `RESEND_API_KEY`: a Resend API key with Sending access (you can reuse the one from SMTP)
   - `MAIL_FROM`: `Cleburne County Sheriff's Office <noreply@ccsoportal.com>`
   - `SITE_URL`: `https://ccsoportal.com/`

3. For time-off requests: **Deploy a new function** → **Via Editor** → name it **`timeoff-alert`** → paste all of `supabase-timeoff-alert-function.ts` → **Deploy**, then turn **off** its "Verify JWT" setting. It uses the same three secrets.

4. For timesheet reminders: **Deploy a new function** → **Via Editor** → name it **`timesheet-reminder`** → paste all of `supabase-timesheet-reminder-function.ts` → **Deploy**, then turn **off** "Verify JWT". Then run `timesheet-reminder.sql` in the **SQL Editor** (after `schema.sql`). That schedules a daily check at 13:00 UTC (8 AM Central in summer, 7 AM in winter). On the last day of each pay period, everyone active who hasn't submitted gets one reminder email. To see who would get one without sending anything, run `select public.run_timesheet_reminder(true);` and then `select content from net._http_response order by created desc limit 1;`.

5. For court / training reminders: **Deploy a new function** → **Via Editor** → name it **`event-reminder`** → paste all of `supabase-event-reminder-function.ts` → **Deploy**, then turn **off** "Verify JWT". Then run `event-reminder.sql` in the **SQL Editor**. That schedules a daily check at 21:00 UTC (4 PM Central in summer, 3 PM in winter) that emails each deputy tagged on a court date, training or other event starting tomorrow. Dry run: `select public.run_event_reminder(true);` then `select content from net._http_response order by created desc limit 1;`.

**Timesheet banner:** separately, anyone who hasn't submitted sees a banner at the top of the site on the last day of the pay period, and after it ends until they submit, with a **Fill it out** button.

**Time-off approvers:** on the **Team** tab, open the sheriff and the chief deputy and tick **Approves time off** (managers only). They get an email for every time-off and comp time request and every off-duty job request, and only they can approve or deny time off; other managers can see requests but not decide them. The database enforces this. If nobody is ticked, any manager can approve and every manager gets the email, so requests never get stuck.

The same people approve who works **off-duty jobs**, and only they (or the site owner) can tick or untick **Approves time off**, or change the role or account of someone who approves. That lets you make **clerks** managers without approvals: they see everything managers see, approve timesheets, edit the team, post events and print payroll, but they can't approve time off, comp time, uniform orders or off-duty jobs, and they can't give themselves that right. Leave **Approves time off** unticked for them.

If alerts aren't set up, everything still saves; the site shows a one-time note that the email couldn't be sent. Deactivated people never get emails.

## Jail portal (`/jail/`)

The Cleburne County Jail has its own portal at `ccsoportal.com/jail/`. It's the same app (`app.js`, `style.css`) with its own `jail/config.js` and **its own Supabase project**, so jail logins, records, approvals and audit log are completely separate from the Sheriff's Office. It has only the calendar, timesheets and time off (`FEATURES` in `jail/config.js` turns off case numbers, patrol stats and off-duty jobs; comp time is only for people ticked **Has comp time** on the Team tab, e.g. the jail administrator), prints **CLEBURNE COUNTY JAIL** on timesheets, and shows a "Jail" label. Managers see a link to the other portal in the Admin menu.

One-time setup:
1. **supabase.com → New project** (e.g. "CCSO Jail").
2. **SQL Editor:** run `schema.sql`.
3. **Authentication → Sign In / Providers:** turn off "Allow new users to sign up". **URL Configuration:** Site URL and Redirect URLs `https://ccsoportal.com/jail/`. **Emails → SMTP:** the same Resend sender as the Sheriff's Office project.
4. **Edge Functions:** deploy `notify`, `invite-user`, `timeoff-alert`, `timesheet-reminder`, `event-reminder` and `event-ics` from this repo (each with "Verify JWT" off). **Secrets:** `RESEND_API_KEY` (a Resend key), `MAIL_FROM` = `Cleburne County Jail <noreply@ccsoportal.com>`, `SITE_URL` = `https://ccsoportal.com/jail/`, and `ORG_NAME` = `Cleburne County Jail` (the name in the emails' footer).
   **Authentication → Emails → Templates:** paste `jail/email-invite.html` into **Invite user** and `jail/email-reset-password.html` into **Reset password** (each file's top lines give the subject to use).
5. **SQL Editor:** run `timesheet-reminder.sql` and `event-reminder.sql`, after changing the address on the line marked ▼ near the top of each to the jail project's address (Project Settings → Data API → Project URL).
6. **`jail/config.js`:** paste the jail project's URL and anon / publishable key over `YOUR-PROJECT` / `YOUR-ANON-KEY`.
7. **Invite** the jail administrator, then run in the jail project's SQL Editor: `update public.profiles set role = 'manager', timeoff_approver = true where email = '…';` (do the same for the sheriff, without `timeoff_approver` if he shouldn't get the emails). Optionally make yourself site owner there too (`is_owner = true`). Then invite jail staff from the Team tab.
8. Ask for the "Jail portal" link to be turned on in the Sheriff's Office `config.js` (`OTHER_PORTAL: { label: 'Jail portal', url: 'jail/' }`).

When updating the site, bump the `?v=` version in **both** `index.html` and `jail/index.html`.

## Install on a phone

The portal can sit on the home screen like an app (full screen, seal icon, "CCSO Portal"):
- **iPhone:** open the site in Safari → Share button → **Add to Home Screen**.
- **Android:** open it in Chrome → ⋮ menu → **Install app** (or **Add to Home screen**).
People sign in once inside the installed app.

## Security features

- **Auto sign-out:** after 28 minutes with no activity, a warning appears with a 2-minute countdown and a **Stay signed in** button. Any mouse, key or touch activity resets it. At 30 minutes the person is signed out and sees a note on the sign-in page. It works across tabs and when a phone wakes up. To change the time, add `IDLE_MINUTES: 20,` (for example) to `config.js`.
- **Audit log** (site owner only, **Audit Log** tab): the database records every change to timesheets, time off, case numbers, off-duty jobs and requests, calendar events and tags, announcements, people, roles and duties: who, when, what, and before → after. Filter by who did it, whose record it is, area and date; click **Details** for the field-by-field changes. Entries can't be edited or deleted from the website, not even by managers. Signature images aren't copied into the log. Changes made directly in the Supabase dashboard show as "Dashboard / system". Sign-ins themselves are in Supabase → Logs → Auth.
