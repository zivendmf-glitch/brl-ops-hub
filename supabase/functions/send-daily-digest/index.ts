// BRL Ops Digest — send-daily-digest v2 (2026-09-13)
//
// What changed vs v1:
//  • Cost model now mirrors the dashboard exactly: effective-dated fuel prices
//    (bbm_rate_history), Maredan rate multiplier (rate_multiplier_history),
//    dated work-type rates (work_type_rate_history), per-class premi overrides
//    (work_type_premi), dated equipment rental (equipment_rental.effective_from),
//    Prabumuli fuel = excess above contract threshold, Prabumuli helper/subsidi
//    (site_extra_costs), per-site daily fixed (<site>_daily_cost) incl. SAM2.
//  • Reports the LATEST day each site actually has data for (capped at D-1),
//    instead of a fixed D-2 — and flags how stale each site is.
//  • Adds previous-day delta, trailing 7-day and book-period-to-date (26th→25th).
//  • Alerts: stale uploads, BD ≥7d/≥14d, fuel runway + negative saldo, units
//    burning above the L/HM investigate threshold, unknown work types (Rp 0 revenue).
//  • Paginates time_sheet reads (Supabase caps a single read at 1,000 rows).
//  • ?dry=1 → compute + return JSON summary, no email.
//    ?preview=1&key=<DIGEST_PREVIEW_KEY> → return the HTML (no email).
//    ?date=YYYY-MM-DD → pretend "today" (Jakarta) is that date.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RECIPIENT_EMAIL = Deno.env.get("RECIPIENT_EMAIL") || "manager@brl.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "BRL Ops <onboarding@resend.dev>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PREVIEW_KEY = Deno.env.get("DIGEST_PREVIEW_KEY") || "";
const DASHBOARD_URL = "https://brlreplanting.netlify.app";

const SITES = ["maredan", "prabumuli", "sam2"] as const;
type Site = typeof SITES[number];
const SITE_LABEL: Record<string, string> = { maredan: "Maredan", prabumuli: "Prabumuli", sam2: "SAM2" };
const ADMIN_NAME: Record<string, string> = { maredan: "Nova", prabumuli: "Ade", sam2: "Ade" };

// ── Dates (all "YYYY-MM-DD" strings are Jakarta calendar days) ─────────────
const JKT_MS = 7 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
function ymdFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymdFromDate(d);
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
function jakartaToday(): string {
  return ymdFromDate(new Date(Date.now() + JKT_MS));
}
function fmtDay(ymd: string, withYear = false): string {
  return new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}
function fmtStamp(iso: string): string {
  // DB timestamps are UTC (no tz) → show Jakarta wall clock
  const norm = iso.replace(" ", "T").replace(/\.(\d{3})\d+/, ".$1");   // V8-safe: 'T' separator, ms precision
  const d = new Date(norm.endsWith("Z") || norm.includes("+") ? norm : norm + "Z");
  return new Date(d.getTime() + JKT_MS).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " WIB";
}
// Book period runs 26th → 25th (see brl-excel-pipeline).
function bookPeriodStart(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  if (d.getUTCDate() >= 26) return ymdFromDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 26)));
  return ymdFromDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 26)));
}

// ── Formatting ─────────────────────────────────────────────────────────────
const fmtRp = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `Rp ${(n / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `Rp ${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `Rp ${(n / 1_000).toFixed(0)}K`;
  return `Rp ${n.toFixed(0)}`;
};
const fmtSign = (n: number) => `${n >= 0 ? "+" : "−"}${fmtRp(Math.abs(n))}`;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtN = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s: string) => SITE_LABEL[s] || s.charAt(0).toUpperCase() + s.slice(1);

// ── Data access ────────────────────────────────────────────────────────────
// Supabase returns at most 1,000 rows per request. time_sheet exceeds that.
async function fetchAll(sb: SupabaseClient, table: string, apply?: (q: any) => any, orderBy = "id"): Promise<any[]> {
  const out: any[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select("*").order(orderBy, { ascending: true }).range(from, from + page - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

// ── Cost model (mirrors index.html: bbmRateFor / bbmPerLiterFor / wtRateFor /
//    rateMultiplierFor / premiRateFor / rentalRateOn / extraCostFor / dailyFixedFor)
interface Model {
  settings: Record<string, number>;
  wt: Record<string, any>;                       // site|work_name → work_types row
  unitClass: Record<string, string>;             // site|unit_code → class
  classCount: Record<string, number>;            // site|class → number of machines
  bbmRates: Record<string, { from: string; rate: number }[]>;      // DESC by from
  rateMults: Record<string, { from: string; mult: number }[]>;     // DESC by from
  wtRates: Record<string, { from: string; rate: number }[]>;       // site|work → DESC
  premiOv: Record<string, number>;               // site|work|class → premi
  rental: Record<string, { rate: number; from: string | null }>;   // site|class
  dailyCost: Record<string, { from: string; rate: number }[]>;     // site → DESC by from (daily_cost_history)
  extra: Record<string, { helper: { rate: number; from: string | null } | null; subsidiPerHa: { rate: number; from: string | null } | null }>;
}

function buildModel(raw: {
  settings: any[]; workTypes: any[]; units: any[]; bbmHist: any[]; multHist: any[];
  wtHist: any[]; premiOv: any[]; rental: any[]; extraCosts: any[]; dailyHist: any[];
}): Model {
  const m: Model = { settings: {}, wt: {}, unitClass: {}, classCount: {}, bbmRates: {}, rateMults: {}, wtRates: {}, premiOv: {}, rental: {}, extra: {}, dailyCost: {} };
  raw.settings.forEach((s) => { const v = parseFloat(s.value); if (!isNaN(v)) m.settings[s.key] = v; });
  raw.workTypes.forEach((w) => { m.wt[w.site + "|" + w.work_name] = w; });
  raw.units.forEach((u) => {
    if (!u.unit_class) return;
    m.unitClass[u.site + "|" + u.unit_code] = u.unit_class;
    m.classCount[u.site + "|" + u.unit_class] = (m.classCount[u.site + "|" + u.unit_class] || 0) + 1;
  });
  const desc = (a: { from: string }, b: { from: string }) => (a.from < b.from ? 1 : -1);
  raw.bbmHist.forEach((r) => { (m.bbmRates[r.site] = m.bbmRates[r.site] || []).push({ from: r.effective_from, rate: parseFloat(r.rate_per_liter) || 0 }); });
  Object.values(m.bbmRates).forEach((l) => l.sort(desc));
  raw.multHist.forEach((r) => { (m.rateMults[r.site] = m.rateMults[r.site] || []).push({ from: r.effective_from, mult: parseFloat(r.multiplier) || 1 }); });
  Object.values(m.rateMults).forEach((l) => l.sort(desc));
  raw.wtHist.forEach((r) => { const k = r.site + "|" + r.work_name; (m.wtRates[k] = m.wtRates[k] || []).push({ from: r.effective_from, rate: parseFloat(r.rate) || 0 }); });
  Object.values(m.wtRates).forEach((l) => l.sort(desc));
  raw.premiOv.forEach((r) => { m.premiOv[r.site + "|" + r.work_name + "|" + r.unit_class] = parseFloat(r.premi) || 0; });
  raw.rental.forEach((r) => { m.rental[r.site + "|" + r.unit_class] = { rate: parseFloat(r.rate_per_hm) || 0, from: r.effective_from || null }; });
  raw.dailyHist.forEach((r) => { (m.dailyCost[r.site] = m.dailyCost[r.site] || []).push({ from: r.effective_from, rate: parseFloat(r.rate_per_unit_day) || 0 }); });
  Object.values(m.dailyCost).forEach((l) => l.sort(desc));
  raw.extraCosts.forEach((r) => {
    const site = (m.extra[r.site] = m.extra[r.site] || { helper: null, subsidiPerHa: null });
    const rate = parseFloat(r.rate_per_ha) || 0;
    if (r.cost_type === "helper") site.helper = { rate, from: r.effective_from || null };
    else if (r.cost_type === "subsidi") {
      const n = m.classCount[r.site + "|" + r.unit_class] || 0;
      const prev = site.subsidiPerHa || { rate: 0, from: r.effective_from || null };
      site.subsidiPerHa = { rate: prev.rate + rate * n, from: prev.from || r.effective_from || null };
    }
  });
  return m;
}

function bbmRateFor(m: Model, site: string, date: string, fallback: number): number {
  const list = m.bbmRates[site];
  if (!list || !list.length) return fallback;
  for (const r of list) if (r.from <= date) return r.rate;
  return list[list.length - 1].rate;
}
function bbmPerLiterFor(m: Model, site: string, date: string): number {
  if (site === "prabumuli") {
    const mkt = bbmRateFor(m, "prabumuli", date, m.settings["prabumuli_bbm_per_liter"] || 25000);
    return Math.max(0, mkt - (m.settings["prabumuli_bbm_threshold"] || 15000));
  }
  return bbmRateFor(m, site, date, m.settings[site + "_bbm_per_liter"] || m.settings["maredan_bbm_per_liter"] || 27000);
}
function rateMultiplierFor(m: Model, site: string, date: string): number {
  const list = m.rateMults[site];
  if (!list || !list.length) return 1;
  for (const r of list) if (r.from <= date) return r.mult;
  return 1;
}
function wtRateFor(m: Model, site: string, work: string, date: string, fallback: any): number {
  const list = m.wtRates[site + "|" + work];
  if (list && list.length) for (const r of list) if (r.from <= date) return r.rate;
  return parseFloat(fallback) || 0;
}
function premiRateFor(m: Model, site: string, work: string, unitCode: string, fallback: any): number {
  const cls = m.unitClass[site + "|" + unitCode];
  if (cls) { const v = m.premiOv[site + "|" + work + "|" + cls]; if (v !== undefined) return v; }
  return parseFloat(fallback) || 0;
}
function rentalRateOn(m: Model, site: string, cls: string | undefined, date: string): number {
  if (!cls) return 0;
  const e = m.rental[site + "|" + cls];
  if (!e) return 0;
  if (e.from && date < e.from) return 0;
  return e.rate;
}
function extraCostFor(m: Model, e: any, wtUnit: string | null, cls: string | undefined): number {
  const c = m.extra[e.site];
  if (!c || wtUnit !== "HA") return 0;
  const out = parseFloat(e.output) || 0;
  if (!out) return 0;
  let t = 0;
  if (c.helper && (!c.helper.from || e.date >= c.helper.from)) t += out * c.helper.rate;
  if (cls === "dozer" && c.subsidiPerHa && (!c.subsidiPerHa.from || e.date >= c.subsidiPerHa.from)) t += out * c.subsidiPerHa.rate;
  return t;
}
// Site overhead per unit-day: the dated row in force on that date, else the
// flat <site>_daily_cost setting (mirrors index.html dailyFixedFor).
function dailyFixedFor(m: Model, site: string, date: string): number {
  const list = m.dailyCost[site];
  if (list) for (const r of list) if (r.from <= date) return r.rate;
  const v = m.settings[site + "_daily_cost"];
  if (!isNaN(v) && v !== undefined) return v;
  return site === "prabumuli" ? 138000 : 184000;
}
// Revenue deductions, % of revenue per site (mirrors surveyPctFor / taxPctFor):
// the client's drone survey usually measures ~10% less than the timesheet, and
// PPh 23/21/25 is taken on the surveyed revenue. Defaults are Prabumuli's.
function surveyPct(m: Model, site: string): number {
  const v = m.settings[site + "_survey_pct"];
  return v !== undefined && !isNaN(v) ? v : (site === "prabumuli" ? 10 : 0);
}
function taxPct(m: Model, site: string): number {
  const v = m.settings[site + "_tax_pct"];
  return v !== undefined && !isNaN(v) ? v : (site === "prabumuli" ? 5.9 : 0);
}
// Allocation readers — allocated wins when PRESENT (a legitimate 0 included).
const allocBbm = (e: any) => { const a = parseFloat(e.bbm_allocated); return isNaN(a) ? (parseFloat(e.bbm_liters) || 0) : a; };
const allocHm = (e: any) => { const a = parseFloat(e.hm_allocated); return isNaN(a) ? (parseFloat(e.hm_hours) || 0) : a; };
const isStandby = (e: any) => /standby/i.test(e.work_type || "");

interface Fin {
  entries: number; unitDays: number; hm: number; liters: number;
  revenue: number; premi: number; bbm: number; rental: number; fixed: number; extra: number; cost: number; survey: number; tax: number; net: number; margin: number;
  outputByUnit: Record<string, number>;
  byWork: Record<string, { output: number; unit: string; revenue: number }>;
  perUnit: Record<string, { hm: number; liters: number; output: number; revenue: number; work: Set<string> }>;
  orphanWork: Set<string>;
  days: Set<string>;
}
function financials(m: Model, entries: any[]): Fin {
  const f: Fin = { entries: 0, unitDays: 0, hm: 0, liters: 0, revenue: 0, premi: 0, bbm: 0, rental: 0, fixed: 0, extra: 0, cost: 0, survey: 0, tax: 0, net: 0, margin: 0, outputByUnit: {}, byWork: {}, perUnit: {}, orphanWork: new Set(), days: new Set() };
  const seenUnitDay = new Set<string>();
  const revBySite: Record<string, number> = {};   // survey/tax rates differ by site
  for (const e of entries) {
    f.entries++;
    f.days.add(e.date);
    const udKey = (e.unit_code || "?") + "|" + e.date;
    if (!seenUnitDay.has(udKey)) { seenUnitDay.add(udKey); f.fixed += dailyFixedFor(m, e.site, e.date); }
    const wt = m.wt[e.site + "|" + e.work_type];
    const hm = allocHm(e), lit = allocBbm(e), out = parseFloat(e.output) || 0;
    const pu = (f.perUnit[e.unit_code || "?"] = f.perUnit[e.unit_code || "?"] || { hm: 0, liters: 0, output: 0, revenue: 0, work: new Set() });
    pu.hm += hm; pu.liters += lit; pu.output += out; if (e.work_type) pu.work.add(e.work_type);
    f.hm += hm; f.liters += lit;
    if (!wt) { if (e.work_type && !isStandby(e)) f.orphanWork.add(e.work_type); continue; }   // dashboard skips unknown work types entirely
    const split = wt.is_multi_unit ? 0.5 : 1;
    const cls = m.unitClass[e.site + "|" + e.unit_code];
    const rev = out * wtRateFor(m, e.site, e.work_type, e.date, wt.rate) * rateMultiplierFor(m, e.site, e.date) * split;
    f.revenue += rev;
    revBySite[e.site] = (revBySite[e.site] || 0) + rev;
    f.premi += out * premiRateFor(m, e.site, e.work_type, e.unit_code, wt.premi) * split;
    f.bbm += lit * bbmPerLiterFor(m, e.site, e.date);
    f.rental += hm * rentalRateOn(m, e.site, cls, e.date);
    f.extra += extraCostFor(m, e, wt.unit || null, cls);
    pu.revenue += rev;
    if (out && !isStandby(e)) {
      const u = e.output_unit || wt.unit || "?";
      f.outputByUnit[u] = (f.outputByUnit[u] || 0) + out;
      const bw = (f.byWork[e.work_type] = f.byWork[e.work_type] || { output: 0, unit: u, revenue: 0 });
      bw.output += out; bw.revenue += rev;
    }
  }
  f.unitDays = seenUnitDay.size;
  f.cost = f.premi + f.bbm + f.rental + f.fixed + f.extra;
  for (const [s, r] of Object.entries(revBySite)) {
    const sv = r * surveyPct(m, s) / 100;
    f.survey += sv;
    f.tax += (r - sv) * taxPct(m, s) / 100;
  }
  f.net = f.revenue - f.cost - f.survey - f.tax;
  f.margin = f.revenue > 0 ? (f.net / f.revenue) * 100 : 0;
  return f;
}

// ── The digest ─────────────────────────────────────────────────────────────
interface SiteReport {
  site: string; label: string; admin: string;
  reportDay: string | null; lagDays: number | null; stale: boolean;
  day?: Fin; prev?: Fin; week?: Fin; ptd?: Fin;
  lastUpload?: { filename: string; by: string; at: string; rows: number };
  lastDataDate: string | null;
}
interface Alert { level: "red" | "amber" | "info"; icon: string; title: string; body: string }

async function buildDigest(sb: SupabaseClient, today: string) {
  const yesterday = addDays(today, -1);
  const periodStart = bookPeriodStart(today);
  const fetchFrom = addDays(today, -21) < periodStart ? addDays(today, -21) : periodStart;

  const [timeSheet, settings, workTypes, units, bbmHist, multHist, wtHist, premiOv, rental, extraCosts, dailyHist, breakdowns, lapBbm, uploads, profiles] = await Promise.all([
    fetchAll(sb, "time_sheet", (q) => q.gte("date", fetchFrom).lte("date", yesterday)),
    fetchAll(sb, "app_settings", undefined, "key"),
    fetchAll(sb, "work_types"),
    fetchAll(sb, "units"),
    fetchAll(sb, "bbm_rate_history").catch(() => []),
    fetchAll(sb, "rate_multiplier_history").catch(() => []),
    fetchAll(sb, "work_type_rate_history").catch(() => []),
    fetchAll(sb, "work_type_premi").catch(() => []),
    fetchAll(sb, "equipment_rental").catch(() => []),
    fetchAll(sb, "site_extra_costs").catch(() => []),
    fetchAll(sb, "daily_cost_history").catch(() => []),
    fetchAll(sb, "breakdowns", (q) => q.is("end_date", null)),
    fetchAll(sb, "lap_bbm", (q) => q.gte("date", addDays(today, -14))),
    fetchAll(sb, "uploads", (q) => q.gte("created_at", addDays(today, -30))),
    fetchAll(sb, "profiles").catch(() => []),
  ]);

  const m = buildModel({ settings, workTypes, units, bbmHist, multHist, wtHist, premiOv, rental, extraCosts, dailyHist });
  const S = m.settings;
  const bdOverhaul = S["bd_overhaul_days"] || 14, bdCritical = S["bd_critical_days"] || 7;
  const bbmCriticalDays = S["bbm_critical_days"] || 2, bbmWatchDays = S["bbm_watch_days"] || 5;
  const lhmInvestigate = S["lhm_investigate"] || 22;
  const profName: Record<string, string> = {};
  profiles.forEach((p: any) => { profName[p.id] = p.full_name || p.username; });

  // Per-site reports -------------------------------------------------------
  const reports: SiteReport[] = [];
  for (const site of SITES) {
    const rows = timeSheet.filter((e: any) => e.site === site);
    const dates = [...new Set(rows.map((e: any) => String(e.date)))].sort();
    const lastDataDate = dates.length ? dates[dates.length - 1] : null;
    const up = uploads.filter((u: any) => u.site === site).sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))[0];
    const r: SiteReport = {
      site, label: cap(site), admin: ADMIN_NAME[site] || "admin",
      reportDay: lastDataDate, lagDays: lastDataDate ? daysBetween(lastDataDate, today) : null,
      stale: !lastDataDate || daysBetween(lastDataDate, today) > 14,
      lastDataDate,
      lastUpload: up ? { filename: up.filename, by: profName[up.uploaded_by] || ADMIN_NAME[site] || "?", at: up.created_at, rows: up.rows_processed || 0 } : undefined,
    };
    if (lastDataDate && !r.stale) {
      const d = lastDataDate;
      r.day = financials(m, rows.filter((e: any) => e.date === d));
      const prevDates = dates.filter((x) => x < d);
      if (prevDates.length) { const pd = prevDates[prevDates.length - 1]; r.prev = financials(m, rows.filter((e: any) => e.date === pd)); (r.prev as any).date = pd; }
      const wkStart = addDays(d, -6);
      r.week = financials(m, rows.filter((e: any) => e.date >= wkStart && e.date <= d));
      r.ptd = financials(m, rows.filter((e: any) => e.date >= periodStart && e.date <= d));
    }
    reports.push(r);
  }

  // Alerts -----------------------------------------------------------------
  const alerts: Alert[] = [];

  // 1. Data freshness
  for (const r of reports) {
    if (r.site === "sam2" && r.stale) continue;               // SAM2 is intermittent; noted in footer instead
    const upTxt = r.lastUpload ? `Last upload: <em>${esc(r.lastUpload.filename)}</em> by ${esc(r.lastUpload.by)}, ${fmtStamp(r.lastUpload.at)} (${r.lastUpload.rows} rows).` : "No upload recorded in the last 30 days.";
    if (!r.lastDataDate) {
      alerts.push({ level: "red", icon: "📋", title: `${r.label}: no time-sheet data in the last 3 weeks`, body: `${upTxt} Check with ${r.admin}.` });
    } else if (r.lagDays! > 2) {
      alerts.push({ level: r.lagDays! > 4 ? "red" : "amber", icon: "📋", title: `${r.label}: data stops at ${fmtDay(r.lastDataDate)} (${r.lagDays} days ago)`, body: `${upTxt} Expected up to ${fmtDay(addDays(today, -2))} by now — ask ${r.admin} for the latest template.` });
    }
  }

  // 2. Breakdowns
  const bds = breakdowns.map((b: any) => ({ ...b, days: b.start_date ? daysBetween(String(b.start_date), today) : 0 })).sort((a: any, b: any) => b.days - a.days);
  const overhaul = bds.filter((b: any) => b.days >= bdOverhaul);
  const critical = bds.filter((b: any) => b.days >= bdCritical && b.days < bdOverhaul);
  const bdLine = (b: any) => `<li><strong>${esc(b.unit_code)}</strong> (${cap(b.site)}) — ${esc(b.description || "BD")} · <strong>${b.days}d</strong> since ${fmtDay(String(b.start_date))}${b.action ? ` · ${esc(b.action)}` : ""}</li>`;
  if (overhaul.length) alerts.push({ level: "red", icon: "🔧", title: `Overhaul / replace decision needed — ${overhaul.length} unit${overhaul.length > 1 ? "s" : ""} on standby ≥ ${bdOverhaul}d`, body: `<ul>${overhaul.slice(0, 8).map(bdLine).join("")}</ul>` });
  if (critical.length) alerts.push({ level: "amber", icon: "🔧", title: `Breakdown ${bdCritical}–${bdOverhaul - 1}d — ${critical.length} unit${critical.length > 1 ? "s" : ""}`, body: `<ul>${critical.slice(0, 8).map(bdLine).join("")}</ul>` });

  // 3. Fuel stock
  const fuel: Record<string, { latest: any; avgBurn: number; runway: number; lastDelivery: any }> = {};
  for (const site of SITES) {
    const rows = lapBbm.filter((b: any) => b.site === site).sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
    if (!rows.length) continue;
    const latest = rows[rows.length - 1];
    const last7 = rows.slice(-7);
    const avgBurn = last7.reduce((s: number, b: any) => s + (parseFloat(b.total_keluar) || 0), 0) / last7.length;
    const saldo = parseFloat(latest.saldo) || 0;
    const runway = avgBurn > 0 ? saldo / avgBurn : 999;
    const lastDelivery = [...rows].reverse().find((b: any) => (parseFloat(b.bbm_masuk) || 0) > 0);
    fuel[site] = { latest, avgBurn, runway, lastDelivery };
    const ageDays = daysBetween(String(latest.date), today);
    const deliv = lastDelivery ? ` Last delivery ${fmtN(parseFloat(lastDelivery.bbm_masuk))} L on ${fmtDay(String(lastDelivery.date))}.` : "";
    if (saldo < 0) {
      alerts.push({ level: "amber", icon: "⛽", title: `${cap(site)} fuel book shows negative saldo (${fmtN(saldo)} L as of ${fmtDay(String(latest.date))})`, body: `Issued fuel exceeds recorded deliveries — a delivery is probably missing from the lap BBM sheet.${deliv} Ask ${ADMIN_NAME[site]} to reconcile.` });
    } else if (runway < bbmCriticalDays) {
      alerts.push({ level: "red", icon: "⛽", title: `${cap(site)} fuel critical — ${runway.toFixed(1)} days left`, body: `Saldo ${fmtN(saldo)} L as of ${fmtDay(String(latest.date))} · burn ${fmtN(avgBurn)} L/day.${deliv} <strong>Order today.</strong>` });
    } else if (runway < bbmWatchDays) {
      alerts.push({ level: "amber", icon: "⛽", title: `${cap(site)} fuel watch — ${runway.toFixed(1)} days left`, body: `Saldo ${fmtN(saldo)} L as of ${fmtDay(String(latest.date))} · burn ${fmtN(avgBurn)} L/day.${deliv}` });
    }
    if (ageDays > 3 && !(reports.find((r) => r.site === site)?.stale)) {
      alerts.push({ level: "info", icon: "⛽", title: `${cap(site)} lap BBM last updated ${fmtDay(String(latest.date))} (${ageDays} days ago)`, body: `Fuel runway is estimated from stale figures.` });
    }
  }

  // 4. Fuel burn outliers + unknown work types on the report day
  for (const r of reports) {
    if (!r.day) continue;
    const hot = Object.entries(r.day.perUnit)
      .filter(([, u]) => u.hm >= 2 && u.liters / u.hm > lhmInvestigate && ![...u.work].every((w) => /standby/i.test(w)))
      .map(([code, u]) => ({ code, lhm: u.liters / u.hm, hm: u.hm, liters: u.liters }))
      .sort((a, b) => b.lhm - a.lhm);
    if (hot.length) alerts.push({ level: "amber", icon: "🔥", title: `${r.label}: ${hot.length} unit${hot.length > 1 ? "s" : ""} above ${lhmInvestigate} L/HM on ${fmtDay(r.reportDay!)}`, body: `<ul>${hot.slice(0, 6).map((h) => `<li><strong>${esc(h.code)}</strong> — ${h.lhm.toFixed(1)} L/HM (${fmtN(h.liters)} L over ${h.hm.toFixed(1)} HM)</li>`).join("")}</ul><p>Fuel is spread back over blank days by the parser, so a single day can spike; investigate if it persists.</p>` });
    if (r.day.orphanWork.size) alerts.push({ level: "red", icon: "❓", title: `${r.label}: work type${r.day.orphanWork.size > 1 ? "s" : ""} not in the rate table — earning Rp 0`, body: `<ul>${[...r.day.orphanWork].map((w) => `<li>${esc(w)}</li>`).join("")}</ul><p>Add the work type (or fix the spelling in the template) or this revenue is lost from every report.</p>` });
    const idle = Object.entries(r.day.perUnit).filter(([, u]) => u.hm > 0 && u.output === 0).map(([c]) => c);
    if (idle.length >= 3) alerts.push({ level: "info", icon: "💤", title: `${r.label}: ${idle.length} units ran hours with zero output on ${fmtDay(r.reportDay!)}`, body: `${idle.map(esc).join(", ")} — standby/rolling or unrecorded output?` });
  }

  const rank = { red: 0, amber: 1, info: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level]);

  // Fleet snapshot ----------------------------------------------------------
  const fleet: Record<string, { active: number; bd: number; total: number }> = {};
  units.forEach((u: any) => {
    if (u.status === "retired") return;
    const f = (fleet[u.site] = fleet[u.site] || { active: 0, bd: 0, total: 0 });
    f.total++; if (u.status === "bd") f.bd++; else f.active++;
  });

  // Subject + summary -------------------------------------------------------
  const subjParts = reports.filter((r) => !(r.site === "sam2" && r.stale)).map((r) => {
    if (!r.day) return `${r.label} no data`;
    const stale = r.lagDays! > 2 ? ` ⚠${r.lagDays}d old` : "";
    return `${r.label} ${fmtSign(r.day.net)}${stale}`;
  });
  const hasRed = alerts.some((a) => a.level === "red");
  const subject = `${hasRed ? "⚠ " : ""}BRL Ops ${fmtDay(today)} — ${subjParts.join(" · ")}`;

  const summary = {
    today, period_start: periodStart,
    sites: Object.fromEntries(reports.map((r) => [r.site, {
      report_day: r.reportDay, lag_days: r.lagDays, stale: r.stale,
      day: r.day ? { entries: r.day.entries, unit_days: r.day.unitDays, hm: +r.day.hm.toFixed(1), liters: Math.round(r.day.liters), revenue: Math.round(r.day.revenue), premi: Math.round(r.day.premi), bbm: Math.round(r.day.bbm), rental: Math.round(r.day.rental), fixed: Math.round(r.day.fixed), extra: Math.round(r.day.extra), cost: Math.round(r.day.cost), survey: Math.round(r.day.survey), tax: Math.round(r.day.tax), net: Math.round(r.day.net), margin: +r.day.margin.toFixed(1) } : null,
      ptd: r.ptd ? { days: r.ptd.days.size, revenue: Math.round(r.ptd.revenue), cost: Math.round(r.ptd.cost), survey: Math.round(r.ptd.survey), tax: Math.round(r.ptd.tax), net: Math.round(r.ptd.net), margin: +r.ptd.margin.toFixed(1) } : null,
    }])),
    alerts: alerts.map((a) => ({ level: a.level, title: a.title })),
    fuel: Object.fromEntries(Object.entries(fuel).map(([s, f]) => [s, { as_of: f.latest.date, saldo: Math.round(parseFloat(f.latest.saldo) || 0), avg_burn: Math.round(f.avgBurn), runway_days: +f.runway.toFixed(1) }])),
  };

  const html = renderHtml({ today, periodStart, reports, alerts, fuel, fleet, bds, m });
  return { subject, html, summary };
}

// ── HTML ───────────────────────────────────────────────────────────────────
const C = { navy: "#1e3a6e", ink: "#1a1a1a", mute: "#6b7280", line: "#e5e7eb", bg: "#f8f8f6", green: "#15803d", red: "#b91c1c", amber: "#c2410c" };
const th = (t: string, right = false) => `<th style="text-align:${right ? "right" : "left"};font-size:11px;color:${C.mute};font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:0 0 6px;border-bottom:1px solid ${C.line}">${t}</th>`;
const td = (t: string, right = false, extra = "") => `<td style="padding:5px 0;font-size:13px;text-align:${right ? "right" : "left"};${extra}">${t}</td>`;
const pnlColor = (n: number) => (n >= 0 ? C.green : C.red);
const marginColor = (n: number) => (n >= 5 ? C.green : n >= 0 ? C.amber : C.red);

function outputLine(f: Fin): string {
  const parts = Object.entries(f.outputByUnit).sort((a, b) => b[1] - a[1]).map(([u, v]) => `${fmtN(v, u === "HA" ? 2 : 0)} ${esc(u)}`);
  return parts.length ? parts.join(" · ") : "—";
}

function siteCard(r: SiteReport, today: string, periodStart: string, fuel: any, fleet: any): string {
  const fl = fleet[r.site] || { active: 0, bd: 0, total: 0 };
  const fleetTxt = `${fl.active} active · ${fl.bd} BD`;
  if (r.stale || !r.day) {
    return `
    <div style="background:${C.bg};border:1px solid ${C.line};border-radius:10px;padding:16px 18px;margin:12px 0">
      <h3 style="margin:0 0 4px;color:${C.navy};font-size:16px">${r.label} <span style="font-weight:400;color:${C.mute};font-size:12px">· ${fleetTxt}</span></h3>
      <p style="margin:0;font-size:13px;color:${C.mute}">${r.lastDataDate ? `No data since ${fmtDay(r.lastDataDate, true)}.` : "No time-sheet data in the last 3 weeks."}${r.lastUpload ? ` Last upload by ${esc(r.lastUpload.by)} on ${fmtStamp(r.lastUpload.at)}.` : ""}</p>
    </div>`;
  }
  const d = r.day, p = r.prev, w = r.week!, ptd = r.ptd!;
  const lagTag = r.lagDays! > 2
    ? `<span style="background:#fff7ed;color:${C.amber};font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:6px">${r.lagDays} days old</span>`
    : `<span style="background:#ecfdf5;color:${C.green};font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:6px">D-${r.lagDays}</span>`;
  const delta = p ? `<span style="font-size:11px;color:${C.mute};font-weight:400"> vs ${fmtDay((p as any).date)}: <span style="color:${pnlColor(d.net - p.net)}">${fmtSign(d.net - p.net)}</span></span>` : "";
  const lhm = d.hm > 0 ? (d.liters / d.hm).toFixed(1) : "—";
  const wkDays = w.days.size || 1;
  const topWork = Object.entries(d.byWork).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 4)
    .map(([k, v]) => `<tr>${td(esc(k))}${td(`${fmtN(v.output, v.unit === "HA" ? 2 : 0)} ${esc(v.unit)}`, true)}${td(fmtRp(v.revenue), true, `color:${C.mute}`)}</tr>`).join("");
  const costRow = (label: string, v: number) => v > 0 ? `<tr>${td(label, false, `color:${C.mute}`)}${td(fmtRp(v), true, `color:${C.mute}`)}</tr>` : "";

  return `
  <div style="background:${C.bg};border:1px solid ${C.line};border-radius:10px;padding:16px 18px;margin:12px 0">
    <h3 style="margin:0 0 2px;color:${C.navy};font-size:16px">${r.label}${lagTag}</h3>
    <p style="margin:0 0 12px;font-size:12px;color:${C.mute}">Report day <strong style="color:${C.ink}">${fmtDay(r.reportDay!, true)}</strong> · ${fleetTxt}</p>

    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:0 0 10px;vertical-align:top;width:50%">
          <div style="font-size:11px;color:${C.mute};text-transform:uppercase;letter-spacing:.5px">Net P&amp;L (day)</div>
          <div style="font-size:22px;font-weight:700;color:${pnlColor(d.net)}">${fmtSign(d.net)}</div>
          <div style="font-size:12px;color:${marginColor(d.margin)}">margin ${fmtPct(d.margin)}${delta}</div>
        </td>
        <td style="padding:0 0 10px;vertical-align:top;width:50%">
          <div style="font-size:11px;color:${C.mute};text-transform:uppercase;letter-spacing:.5px">Period to date · from ${fmtDay(periodStart)}</div>
          <div style="font-size:22px;font-weight:700;color:${pnlColor(ptd.net)}">${fmtSign(ptd.net)}</div>
          <div style="font-size:12px;color:${marginColor(ptd.margin)}">margin ${fmtPct(ptd.margin)} · ${ptd.days.size} days · rev ${fmtRp(ptd.revenue)}</div>
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:4px">
      <tr>${th("Day detail")}${th(fmtDay(r.reportDay!), true)}${th("7-day avg", true)}</tr>
      <tr>${td("Units worked")}${td(`${d.unitDays}`, true)}${td(`${(w.unitDays / wkDays).toFixed(1)}`, true)}</tr>
      <tr>${td("Hours (HM)")}${td(fmtN(d.hm, 1), true)}${td(fmtN(w.hm / wkDays, 1), true)}</tr>
      <tr>${td("Fuel")}${td(`${fmtN(d.liters)} L · ${lhm} L/HM`, true)}${td(`${fmtN(w.liters / wkDays)} L · ${w.hm > 0 ? (w.liters / w.hm).toFixed(1) : "—"} L/HM`, true)}</tr>
      <tr>${td("Output")}${td(outputLine(d), true)}${td("", true)}</tr>
      <tr>${td("Revenue", false, "font-weight:600")}${td(fmtRp(d.revenue), true, "font-weight:600")}${td(fmtRp(w.revenue / wkDays), true)}</tr>
      ${costRow("BBM", d.bbm)}${costRow("Equipment rental", d.rental)}${costRow("Premi", d.premi)}${costRow("Daily fixed", d.fixed)}${costRow("Helper / subsidi", d.extra)}
      <tr>${td("Total cost", false, `border-top:1px solid ${C.line};font-weight:600`)}${td(fmtRp(d.cost), true, `border-top:1px solid ${C.line};font-weight:600`)}${td(fmtRp(w.cost / wkDays), true, `border-top:1px solid ${C.line}`)}</tr>
      ${d.survey > 0 ? `<tr>${td("Survey adjustment", false, `color:${C.mute}`)}${td("− " + fmtRp(d.survey), true, `color:${C.mute}`)}</tr>` : ""}
      ${d.tax > 0 ? `<tr>${td("Tax (PPh)", false, `color:${C.mute}`)}${td("− " + fmtRp(d.tax), true, `color:${C.mute}`)}</tr>` : ""}
      <tr>${td("Net", false, "font-weight:700")}${td(fmtSign(d.net), true, `font-weight:700;color:${pnlColor(d.net)}`)}${td(fmtSign(w.net / wkDays), true, `color:${pnlColor(w.net)}`)}</tr>
    </table>

    ${topWork ? `<table style="width:100%;border-collapse:collapse;margin-top:14px"><tr>${th("Top work on the day")}${th("Output", true)}${th("Revenue", true)}</tr>${topWork}</table>` : ""}

    ${fuel[r.site] ? `<p style="margin:12px 0 0;font-size:12px;color:${C.mute}">⛽ Stock ${fmtN(parseFloat(fuel[r.site].latest.saldo) || 0)} L as of ${fmtDay(String(fuel[r.site].latest.date))} · burn ${fmtN(fuel[r.site].avgBurn)} L/day · ${fuel[r.site].runway >= 999 ? "runway n/a" : `runway <strong style="color:${fuel[r.site].runway < 2 ? C.red : fuel[r.site].runway < 5 ? C.amber : C.ink}">${fuel[r.site].runway.toFixed(1)} days</strong>`}</p>` : ""}
  </div>`;
}

function alertBlock(a: Alert): string {
  const color = a.level === "red" ? C.red : a.level === "amber" ? C.amber : C.navy;
  const bg = a.level === "red" ? "#fef2f2" : a.level === "amber" ? "#fff7ed" : "#eff6ff";
  return `<div style="background:${bg};border-left:3px solid ${color};padding:10px 14px;margin:8px 0;font-size:13px;line-height:1.5">
    <strong style="color:${color}">${a.icon} ${a.title}</strong>
    <div style="margin-top:4px;color:${C.ink}">${a.body}</div>
  </div>`;
}

function renderHtml(x: { today: string; periodStart: string; reports: SiteReport[]; alerts: Alert[]; fuel: any; fleet: any; bds: any[]; m: Model }): string {
  const { today, periodStart, reports, alerts, fuel, fleet, bds, m } = x;
  const shown = reports.filter((r) => !(r.site === "sam2" && r.stale));
  const sam2 = reports.find((r) => r.site === "sam2");
  const totalDay = shown.reduce((s, r) => s + (r.day?.net || 0), 0);
  const totalPtd = shown.reduce((s, r) => s + (r.ptd?.net || 0), 0);
  const preheader = shown.map((r) => r.day ? `${r.label} ${fmtSign(r.day.net)}` : `${r.label} no data`).join(" · ") + ` · ${alerts.filter((a) => a.level !== "info").length} alerts`;
  const openBd = bds.slice(0, 10).map((b: any) => `<tr>${td(`<strong>${esc(b.unit_code)}</strong>`)}${td(cap(b.site))}${td(esc(b.description || "BD"))}${td(`${b.days}d`, true, `font-weight:600;color:${b.days >= 14 ? C.red : b.days >= 7 ? C.amber : C.ink}`)}</tr>`).join("");
  const modelNote = [
    `Maredan: fuel ${fmtRp(bbmPerLiterFor(m, "maredan", today))}/L · rental per HM by class · premi · fixed ${fmtRp(dailyFixedFor(m, "maredan", today))}/unit-day · rate ×${rateMultiplierFor(m, "maredan", today).toFixed(4)} · survey −${surveyPct(m, "maredan")}% · tax ${taxPct(m, "maredan")}%`,
    `Prabumuli: fuel excess ${fmtRp(bbmPerLiterFor(m, "prabumuli", today))}/L over threshold · rental from ${m.rental["prabumuli|dozer"]?.from || "—"} · premi by class · fixed ${fmtRp(dailyFixedFor(m, "prabumuli", today))}/unit-day · helper/subsidi per HA · survey −${surveyPct(m, "prabumuli")}% · tax ${taxPct(m, "prabumuli")}%`,
  ].join("<br>");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BRL Ops Digest</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="display:none;max-height:0;overflow:hidden;color:#fff;font-size:1px">${esc(preheader)}</div>
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:${C.ink};line-height:1.5;padding:20px 16px">

  <div style="background:linear-gradient(135deg,#0f2547,${C.navy});padding:22px 22px 18px;border-radius:12px">
    <h1 style="color:#fff;margin:0 0 4px;font-size:22px;letter-spacing:-.2px">📊 BRL Ops Digest</h1>
    <p style="color:#9fbfe8;font-size:13px;margin:0">${fmtDay(today, true)} · 06:00 WIB</p>
    <table style="width:100%;border-collapse:collapse;margin-top:14px"><tr>
      ${shown.map((r) => `<td style="padding:0 8px 0 0;vertical-align:top">
        <div style="color:#9fbfe8;font-size:10px;text-transform:uppercase;letter-spacing:.6px">${r.label}${r.day && r.lagDays! > 2 ? ` · ${r.lagDays}d old` : ""}</div>
        <div style="color:#fff;font-size:18px;font-weight:700">${r.day ? fmtSign(r.day.net) : "—"}</div>
        <div style="color:#cbd5e1;font-size:11px">${r.day ? `${fmtDay(r.reportDay!)} · ${fmtPct(r.day.margin)}` : "no data"}</div>
      </td>`).join("")}
      <td style="padding:0;vertical-align:top;border-left:1px solid rgba(255,255,255,.15);padding-left:12px">
        <div style="color:#9fbfe8;font-size:10px;text-transform:uppercase;letter-spacing:.6px">Period to date</div>
        <div style="color:#fff;font-size:18px;font-weight:700">${fmtSign(totalPtd)}</div>
        <div style="color:#cbd5e1;font-size:11px">from ${fmtDay(periodStart)} · day total ${fmtSign(totalDay)}</div>
      </td>
    </tr></table>
  </div>

  <h2 style="color:${C.navy};font-size:12px;text-transform:uppercase;letter-spacing:1.3px;border-bottom:2px solid #e8eef6;padding-bottom:6px;margin:28px 0 8px">Needs attention${alerts.length ? ` · ${alerts.length}` : ""}</h2>
  ${alerts.length ? alerts.map(alertBlock).join("") : `<p style="color:${C.green};font-size:13px">✓ No alerts — data fresh, no long breakdowns, fuel runway fine.</p>`}

  <h2 style="color:${C.navy};font-size:12px;text-transform:uppercase;letter-spacing:1.3px;border-bottom:2px solid #e8eef6;padding-bottom:6px;margin:28px 0 8px">Site performance</h2>
  ${shown.map((r) => siteCard(r, today, periodStart, fuel, fleet)).join("")}

  ${openBd ? `<h2 style="color:${C.navy};font-size:12px;text-transform:uppercase;letter-spacing:1.3px;border-bottom:2px solid #e8eef6;padding-bottom:6px;margin:28px 0 8px">Open breakdowns · ${bds.length}</h2>
  <table style="width:100%;border-collapse:collapse"><tr>${th("Unit")}${th("Site")}${th("Issue")}${th("Standby", true)}</tr>${openBd}</table>` : ""}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid ${C.line};font-size:11px;color:${C.mute};line-height:1.7">
    <a href="${DASHBOARD_URL}" style="color:${C.navy};font-weight:600">Open the dashboard →</a><br>
    ${sam2 && sam2.stale ? `SAM2: ${sam2.lastDataDate ? `no data since ${fmtDay(sam2.lastDataDate, true)}` : "no recent data"} — shown when uploads resume.<br>` : ""}
    Each site shows its latest day with data (max D-1). Book period runs 26th → 25th. Figures use the same dated rates as the dashboard.<br>
    ${modelNote}
  </div>
</div>
</body></html>`;
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const preview = url.searchParams.get("preview") === "1";
    const dateParam = url.searchParams.get("date");
    const today = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : jakartaToday();

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { subject, html, summary } = await buildDigest(sb, today);

    if (preview) {
      if (!PREVIEW_KEY || url.searchParams.get("key") !== PREVIEW_KEY) {
        return new Response("preview disabled — set DIGEST_PREVIEW_KEY and pass ?key=", { status: 403 });
      }
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (dry) {
      return new Response(JSON.stringify({ success: true, dry: true, subject, ...summary }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [RECIPIENT_EMAIL], subject, html }),
    });
    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      console.error("Resend failed:", JSON.stringify(resendData));
      return new Response(JSON.stringify({ error: "Resend failed", details: resendData, subject }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    console.log(`Digest sent: ${subject} (resend ${resendData.id})`);
    return new Response(JSON.stringify({ success: true, subject, resend_id: resendData.id, ...summary }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Digest failed:", e);
    return new Response(JSON.stringify({ error: (e as Error).message, stack: (e as Error).stack }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
