// Daybook email notifications. Runs every 5 minutes (see schedule_reminders.sql).
// Everything is sent to the address the person signed up with, in their own time zone,
// and only for the kinds of email they switched on in Settings › Notifications.
//
// Also answers POST { "test": true } from a signed-in person (their access token in the
// Authorization header) with a test email, so they can check delivery from the app.
//
// Secrets (supabase secrets set ...):
//   RESEND_API_KEY   – from resend.com
//   FROM_EMAIL       – e.g. "Daybook <reminders@yourdomain.com>" (domain verified in Resend)
//   CRON_SECRET      – optional; if set, the cron job must send it as the x-cron-secret header
//   APP_URL          – where your Daybook web app is hosted, for the "Open Daybook" button
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const WINDOW_MIN = 10;       // per-event reminders: catch anything due in the last 10 minutes
const SLOT_MIN = 30;         // scheduled emails (summaries, heads-ups): send within 30 min of the chosen time

type Log = Record<string, { hours?: number; tips?: number }>;
type Ev = { id: string; title: string; cat: string; customLabel?: string; date: string; start?: string; end?: string; allDay?: boolean;
  location?: string; notes?: string; repeat?: string; until?: string; skip?: string[]; remind?: number | null;
  classId?: string; projectId?: string; isTest?: boolean; wage?: number | null; breakMin?: number; log?: Log };
type Step = { id: string; title: string; due?: string; done?: boolean };
type TimelineTask = { id: string; title: string; due?: string; done?: boolean; steps?: Step[] };
type Klass = { id: string; name: string; code?: string; assignments?: { id: string; title: string; due?: string; done?: boolean }[];
  tests?: { id: string; type: string; title?: string; date: string; time?: string; end?: string; room?: string; remind?: number | null }[] };
type Project = { id: string; name: string; due?: string; done?: boolean; tasks?: Step[]; timelines?: TimelineTask[] };
type Due = { key: string; title: string; due: string; from: string; kind: "assign" | "task" };

export type Mail = {
  events: boolean; classes: boolean; shifts: boolean; sessions: boolean;
  tests: boolean;
  // Heads-up email: days ahead to warn (-1 = off). Sent once at alertTime.
  testLead: number; assignLead: number; taskLead: number; deadlineLead: number;
  overdue: boolean; alertTime: string;
  tips: boolean;
  digest: boolean; digestTime: string;
  weekly: boolean; weeklyDay: number; weeklyTime: string; weeklyEarnings: boolean;
};
export const MAIL_DEFAULTS: Mail = {
  events: true, classes: true, shifts: true, sessions: true,
  tests: true, testLead: 2, assignLead: 1, taskLead: 1, deadlineLead: 3, overdue: true, alertTime: "08:00",
  tips: false, digest: false, digestTime: "07:00",
  weekly: false, weeklyDay: 0, weeklyTime: "18:00", weeklyEarnings: true,
};
// Older settings only had emailMode: each | digest | both.
export function mailPrefs(n: Record<string, unknown>): Mail {
  if (n.mail) return { ...MAIL_DEFAULTS, ...(n.mail as Partial<Mail>) };
  const mode = (n.emailMode as string) || "each", each = mode !== "digest";
  return { ...MAIL_DEFAULTS, events: each, classes: each, shifts: each, sessions: each, digest: mode !== "each", digestTime: (n.digestTime as string) || "07:00" };
}

const pad = (n: number) => String(n).padStart(2, "0");
const mins = (t?: string) => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const pd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ds = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return ds(d); };
const daysBetween = (a: string, b: string) => Math.round((+pd(b) - +pd(a)) / 864e5);
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const niceDate = (s: string) => { const d = pd(s); return `${DOW[d.getUTCDay()].slice(0, 3)} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const inDays = (n: number) => n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;

function occursOn(ev: Ev, day: string): boolean {
  if (ev.date === day) return true;
  if (!ev.repeat || ev.repeat === "none" || day < ev.date) return false;
  if (ev.until && day > ev.until) return false;
  if ((ev.skip || []).includes(day)) return false;
  const d = pd(day), s = pd(ev.date), dow = d.getUTCDay();
  switch (ev.repeat) {
    case "daily": return true;
    case "weekdays": return dow > 0 && dow < 6;
    case "weekly": return dow === s.getUTCDay();
    case "biweekly": return dow === s.getUTCDay() && Math.round((+d - +s) / 864e5) % 14 === 0;
    case "monthly": return d.getUTCDate() === s.getUTCDate();
  }
  return false;
}
function localParts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function zonedToUtc(day: string, minutes: number, tz: string): number {
  const guess = +pd(day) + minutes * 60000;
  const off = (t: number) => { const lp = localParts(t, tz); return (+pd(lp.date) + lp.minutes * 60000) - t; };
  let ts = guess - off(guess);
  ts = guess - off(ts);
  return ts;
}
function fmtTime(t: string | undefined, h24: boolean) {
  if (!t) return ""; const [h, m] = t.split(":").map(Number);
  return h24 ? `${pad(h)}:${pad(m)}` : `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const MUTED = "#666D79", RED = "#B4342E";

function shell(title: string, inner: string, appUrl: string, why: string) {
  return `<!doctype html><html><body style="margin:0;background:#EEF0EC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1B2029">
  <div style="max-width:520px;margin:0 auto;padding:28px 18px">
    <div style="font-weight:800;font-size:18px;letter-spacing:-.02em;margin-bottom:18px">Daybook</div>
    <div style="background:#FBFBF9;border:1px solid #DCDFD9;border-radius:14px;padding:22px">
      <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>${inner}
      <a href="${appUrl}" style="display:inline-block;margin-top:18px;background:#1B2029;color:#fff;text-decoration:none;padding:10px 16px;border-radius:9px;font-weight:600;font-size:14px">Open Daybook</a>
    </div>
    <p style="font-size:12px;color:${MUTED};margin-top:14px">You get this because “${why}” is on in Daybook › Settings › Notifications. Turn it off there any time.</p>
  </div></body></html>`;
}
const h2 = (t: string, color = "#1B2029") => `<h2 style="font-size:15px;margin:18px 0 6px;color:${color}">${t}</h2>`;
const ul = (items: string[]) => `<ul style="padding-left:18px;margin:0">${items.map(i => `<li style="margin:5px 0">${i}</li>`).join("")}</ul>`;
const sub = (t: string, color = MUTED) => `<span style="color:${color};font-size:13px">${t}</span>`;

async function sendEmail(to: string, subject: string, html: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL"), to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const appUrl = Deno.env.get("APP_URL") || "https://example.com";

  // ---- "Send me a test email" from a signed-in person in the app ----
  const body = await req.json().catch(() => ({}));
  if (body && body.test) {
    // The gateway checks the public key in the Authorization header; the person's own sign-in token comes in the body.
    const token = body.token || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = token ? await sb.auth.getUser(token) : { data: { user: null } };
    if (!user?.email) return new Response("Forbidden", { status: 403, headers: cors });
    const key = `test:${user.id}:${Math.floor(Date.now() / 60000)}`;
    if ((await sb.from("reminder_log").select("key").eq("key", key).maybeSingle()).data) return Response.json({ sent: 0, note: "Wait a minute before sending another." }, { headers: cors });
    await sb.from("reminder_log").insert({ key, user_id: user.id });
    try {
      await sendEmail(user.email, "Daybook test email", shell("Emails are working", `<p style="margin:0">This is a test from Daybook. Reminders and summaries you switch on will arrive at this address.</p>`, appUrl, "Email notifications"));
      return Response.json({ sent: 1 }, { headers: cors });
    } catch (e) { return Response.json({ sent: 0, error: (e as Error).message }, { status: 502, headers: cors }); }
  }

  // ---- Scheduled run ----
  // Optional shared secret. Without one the job still only sends what is due, once (see reminder_log),
  // so an extra call can't cause duplicate emails.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) return new Response("Forbidden", { status: 403 });
  const now = Date.now();
  let sent = 0; const errors: string[] = [];
  const { data: people, error } = await sb.from("settings").select("user_id,email,data").eq("data->notif->>email", "true");
  if (error) return new Response(error.message, { status: 500 });

  for (const person of people ?? []) {
    try {
      if (!person.email) continue;
      const s = person.data, n = s.notif || {}, M = mailPrefs(n), tz: string = s.tz || "UTC", h24 = !!s.h24;
      const local = localParts(now, tz), today = local.date;
      const already = async (key: string) => (await sb.from("reminder_log").select("key").eq("key", key).maybeSingle()).data != null;
      const mark = (key: string) => sb.from("reminder_log").insert({ key, user_id: person.user_id });
      const inSlot = (hhmm: string) => { const t = mins(hhmm || "08:00"); return local.minutes >= t && local.minutes < t + SLOT_MIN; };
      const send = async (key: string, subject: string, title: string, inner: string, why: string) => {
        await sendEmail(person.email, subject, shell(title, inner, appUrl, why)); await mark(key); sent++;
      };

      const [{ data: evRows }, { data: clRows }, { data: pjRows }] = await Promise.all([
        sb.from("events").select("id,data").eq("user_id", person.user_id),
        sb.from("classes").select("id,data").eq("user_id", person.user_id),
        sb.from("projects").select("id,data").eq("user_id", person.user_id),
      ]);
      const events: Ev[] = (evRows ?? []).map(r => ({ id: r.id, ...r.data }));
      const classes: Klass[] = (clRows ?? []).map(r => ({ id: r.id, ...r.data }));
      const projects: Project[] = (pjRows ?? []).map(r => ({ id: r.id, ...r.data }));
      const classLabel = (c: Klass) => c.code || c.name;
      for (const c of classes) for (const t of c.tests || []) events.push({ id: `test-${c.id}-${t.id}`, title: `${t.title || t.type} · ${classLabel(c)}`, cat: "class", classId: c.id, isTest: true, date: t.date, start: t.time || undefined, end: t.end || undefined, allDay: !t.time, location: t.room, remind: t.remind ?? n.defaultRemind ?? 60 });
      const catName: Record<string, string> = Object.fromEntries((s.categories || []).map((c: { id: string; name: string }) => [c.id, c.name]));
      const payCats: string[] = (s.pay && s.pay.cats) || ["work"];
      const wageDefault: number = (s.pay && s.pay.wage) || 0;
      const currency: string = (s.pay && s.pay.currency) || "USD";
      const money = (v: number) => { try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(v); } catch { return v.toFixed(2); } };
      const kindOf = (e: Ev): keyof Mail => e.isTest ? "tests" : e.classId || e.cat === "class" ? "classes" : e.projectId ? "sessions" : payCats.includes(e.cat) ? "shifts" : "events";
      const label = (e: Ev) => e.cat === "custom" ? (e.customLabel || "Custom") : e.classId ? "Class" : e.projectId ? "Work session" : (catName[e.cat] || "Event");
      const on = (day: string) => events.filter(e => occursOn(e, day)).sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || mins(a.start) - mins(b.start));

      // Open items with due dates: class assignments, project to-dos, timeline steps and task deadlines.
      const dues: Due[] = [
        ...classes.flatMap(c => (c.assignments || []).filter(a => !a.done && a.due).map(a => ({ key: `a:${a.id}`, title: a.title, due: a.due!, from: classLabel(c), kind: "assign" as const }))),
        ...projects.filter(p => !p.done).flatMap(p => [
          ...(p.tasks || []).filter(t => !t.done && t.due).map(t => ({ key: `t:${t.id}`, title: t.title, due: t.due!, from: p.name, kind: "task" as const })),
          ...(p.timelines || []).flatMap(T => [
            ...(T.steps || []).filter(st => !st.done && st.due && !T.done).map(st => ({ key: `s:${st.id}`, title: `${T.title}: ${st.title}`, due: st.due!, from: p.name, kind: "task" as const })),
            ...(!T.done && T.due ? [{ key: `T:${T.id}`, title: T.title, due: T.due, from: p.name, kind: "task" as const }] : []),
          ]),
        ]),
      ];

      // 1) Reminders before each event, per kind.
      for (const day of [today, addDays(today, 1), addDays(today, 2)]) {
        for (const ev of events) {
          if (ev.allDay || ev.remind == null || !M[kindOf(ev)] || !occursOn(ev, day)) continue;
          const start = zonedToUtc(day, mins(ev.start), tz), at = start - ev.remind * 60000;
          if (at > now || at <= now - WINDOW_MIN * 60000 || start < now - 60000) continue;
          const key = `ev:${person.user_id}:${ev.id}:${day}`;
          if (await already(key)) continue;
          const inMin = Math.max(0, Math.round((start - now) / 60000));
          const when = inMin === 0 ? "starting now" : inMin < 60 ? `in ${inMin} min` : inMin < 1440 ? `at ${fmtTime(ev.start, h24)}` : `tomorrow at ${fmtTime(ev.start, h24)}`;
          const inner = `<p style="font-size:15px;margin:0 0 6px"><b>${fmtTime(ev.start, h24)}${ev.end ? "–" + fmtTime(ev.end, h24) : ""}</b> · ${esc(label(ev))}</p>
            ${ev.location ? `<p style="margin:0 0 6px;color:${MUTED}">${esc(ev.location)}</p>` : ""}${ev.notes ? `<p style="margin:10px 0 0">${esc(ev.notes)}</p>` : ""}`;
          const why = { events: "Events and appointments", classes: "Lectures and labs", shifts: "Work shifts", sessions: "Project work sessions", tests: "Tests and quizzes" }[kindOf(ev) as string] || "Email notifications";
          await send(key, `${ev.title} — ${when}`, esc(ev.title), inner, why);
        }
      }

      // 2) "Log your tips" after a paid shift ends.
      if (M.tips) {
        for (const ev of on(today)) {
          if (ev.allDay || !payCats.includes(ev.cat)) continue;
          const end = zonedToUtc(today, mins(ev.end || ev.start), tz);
          if (now < end || now > end + 60 * 60000 || (ev.log?.[today]?.tips != null)) continue;
          const key = `tips:${person.user_id}:${ev.id}:${today}`;
          if (await already(key)) continue;
          await send(key, `How were tips tonight? (${ev.title})`, "Log tonight's tips", `<p style="margin:0">Your ${esc(ev.title)} shift just ended. Add your tips in Daybook so your earnings stay accurate.</p>`, "Tip reminders");
        }
      }

      // 3) Heads-up email: tests, assignments, project tasks and deadlines coming up, plus anything overdue.
      if (inSlot(M.alertTime)) {
        const key = `alert:${person.user_id}:${today}`;
        if (!(await already(key))) {
          const lines: { sec: string; html: string }[] = [];
          if (M.testLead >= 0) for (const e of events.filter(e => e.isTest)) { const d = daysBetween(today, e.date); if (d >= 0 && d <= M.testLead && (d === M.testLead || d <= 1)) lines.push({ sec: "Tests and quizzes", html: `<b>${esc(e.title)}</b> ${sub(`· ${inDays(d)}${e.start ? " at " + fmtTime(e.start, h24) : ""}${e.location ? " · " + esc(e.location) : ""}`)}` }); }
          for (const x of dues) {
            const lead = Number(x.kind === "assign" ? M.assignLead : M.taskLead), want = lead >= 0, d = daysBetween(today, x.due);
            if (want && d >= 0 && d <= lead && (d === lead || d === 0)) lines.push({ sec: x.kind === "assign" ? "Assignments due" : "Project tasks due", html: `${esc(x.title)} ${sub(`· ${esc(x.from)} · due ${inDays(d)}`)}` });
            if (M.overdue && d < 0 && d >= -14) lines.push({ sec: "Overdue", html: `${esc(x.title)} ${sub(`· ${esc(x.from)} · was due ${niceDate(x.due)}`, RED)}` });
          }
          if (M.deadlineLead >= 0) for (const p of projects) { if (p.done || !p.due) continue; const d = daysBetween(today, p.due); if (d >= 0 && d <= M.deadlineLead && (d === M.deadlineLead || d <= 1)) lines.push({ sec: "Project deadlines", html: `<b>${esc(p.name)}</b> ${sub(`· due ${inDays(d)} (${niceDate(p.due)})`, d <= 1 ? RED : MUTED)}` }); }
          if (lines.length) {
            const secs = ["Tests and quizzes", "Assignments due", "Project deadlines", "Project tasks due", "Overdue"];
            const inner = secs.filter(sc => lines.some(l => l.sec === sc)).map(sc => h2(sc, sc === "Overdue" ? RED : undefined) + ul(lines.filter(l => l.sec === sc).map(l => l.html))).join("");
            await send(key, `Coming up: ${lines.length} item${lines.length === 1 ? "" : "s"} to keep an eye on`, "Coming up", inner.replace(/^<h2 style="font-size:15px;margin:18px/, '<h2 style="font-size:15px;margin:0'), "Heads-up email");
          } else await mark(key);
        }
      }

      // 4) Daily summary.
      if (M.digest && inSlot(M.digestTime)) {
        const key = `digest:${person.user_id}:${today}`;
        if (!(await already(key))) {
          const todays = on(today), dueToday = dues.filter(x => x.due === today);
          const rows = todays.map(e => `<tr><td style="padding:7px 12px 7px 0;font-family:Menlo,monospace;font-size:13px;white-space:nowrap;vertical-align:top">${e.allDay ? "All day" : fmtTime(e.start, h24)}</td><td style="padding:7px 0"><b>${esc(e.title)}</b><br>${sub(esc(label(e)) + (e.location ? " · " + esc(e.location) : ""))}</td></tr>`).join("");
          const deadlines = projects.filter(p => !p.done && p.due === today);
          const inner = `${todays.length ? `<table style="border-collapse:collapse;width:100%">${rows}</table>` : `<p style="color:${MUTED};margin:0">Nothing on the calendar today.</p>`}
            ${deadlines.length ? h2("Project deadlines today", RED) + ul(deadlines.map(p => `<b>${esc(p.name)}</b>`)) : ""}
            ${dueToday.length ? h2("Due today") + ul(dueToday.map(x => `${esc(x.title)} ${sub("· " + esc(x.from))}`)) : ""}`;
          await send(key, `Today: ${todays.length} event${todays.length === 1 ? "" : "s"}${dueToday.length ? `, ${dueToday.length} due` : ""}`, `Your ${DOW[pd(today).getUTCDay()]}`, inner, "Daily summary");
        }
      }

      // 5) Weekly summary: the week ahead, plus last week's earnings.
      if (M.weekly && pd(today).getUTCDay() === Number(M.weeklyDay) && inSlot(M.weeklyTime)) {
        const key = `weekly:${person.user_id}:${today}`;
        if (!(await already(key))) {
          const days = [...Array(7)].map((_, i) => addDays(today, i + 1));
          const dayRows = days.map(d => { const es = on(d); return `<tr><td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top">${niceDate(d)}</td><td style="padding:6px 0">${es.length ? es.slice(0, 4).map(e => `${e.allDay ? "" : `<span style="font-family:Menlo,monospace;font-size:12px;color:${MUTED}">${fmtTime(e.start, h24)}</span> `}${esc(e.title)}`).join("<br>") + (es.length > 4 ? `<br>${sub(`+${es.length - 4} more`)}` : "") : sub("Free")}</td></tr>`; }).join("");
          const end = days[6];
          const upcomingDue = dues.filter(x => x.due > today && x.due <= end).sort((a, b) => a.due.localeCompare(b.due));
          const tests = events.filter(e => e.isTest && e.date > today && e.date <= end);
          const dls = projects.filter(p => !p.done && p.due && p.due > today && p.due <= end);
          let earn = "";
          if (M.weeklyEarnings) {
            let hours = 0, wages = 0, tips = 0, count = 0;
            for (let i = 0; i < 7; i++) { const d = addDays(today, -i); for (const e of on(d)) { if (!payCats.includes(e.cat) || e.isTest) continue; const L = e.log?.[d] || {}; const h = L.hours != null ? L.hours : e.allDay ? 0 : Math.max(0, mins(e.end || e.start) - mins(e.start) - (e.breakMin || 0)) / 60; const w = e.wage != null ? e.wage : wageDefault; hours += h; wages += h * w; tips += L.tips || 0; count++; } }
            if (count) earn = h2("Last 7 days of work") + `<p style="margin:0">${count} shift${count === 1 ? "" : "s"} · ${Math.round(hours * 10) / 10} h · <b>${money(wages + tips)}</b> ${sub(`(${money(wages)} wages + ${money(tips)} tips)`)}</p>`;
          }
          const inner = `<table style="border-collapse:collapse;width:100%">${dayRows}</table>
            ${tests.length ? h2("Tests and quizzes") + ul(tests.map(e => `<b>${esc(e.title)}</b> ${sub("· " + niceDate(e.date))}`)) : ""}
            ${dls.length ? h2("Project deadlines", RED) + ul(dls.map(p => `<b>${esc(p.name)}</b> ${sub("· " + niceDate(p.due!))}`)) : ""}
            ${upcomingDue.length ? h2("Due this week") + ul(upcomingDue.map(x => `${esc(x.title)} ${sub(`· ${esc(x.from)} · ${niceDate(x.due)}`)}`)) : ""}${earn}`;
          await send(key, `Your week ahead: ${niceDate(days[0])} – ${niceDate(end)}`, "Your week ahead", inner, "Weekly summary");
        }
      }
    } catch (e) { errors.push(`${person.user_id}: ${(e as Error).message}`); }
  }
  if (Math.random() < 0.02) await sb.rpc("prune_reminder_log");
  return Response.json({ sent, errors });
});
