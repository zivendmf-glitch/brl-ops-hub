// BRL Daily Digest Edge Function — UPDATED with equipment rental + new cost structure
// FIX: HM field name (was reading wrong field, equipment rental was always Rp 0)
// FIX: alert wording — "no data for [date]" instead of "hasn't uploaded"

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RECIPIENT_EMAIL = Deno.env.get("RECIPIENT_EMAIL") || "manager@brl.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "BRL Ops <onboarding@resend.dev>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const now = new Date();
    const indonesia = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const reportDate = new Date(indonesia.getTime() - 2 * 86400000);
    const reportDateStr = reportDate.toISOString().slice(0, 10);
    const today = indonesia.toISOString().slice(0, 10);

    const [tsRes, wtRes, bdRes, bbmRes, unitsRes, opRes, settingsRes, rentalRes] = await Promise.all([
      supabase.from("time_sheet").select("*").eq("date", reportDateStr),
      supabase.from("work_types").select("*"),
      supabase.from("breakdowns").select("*").is("end_date", null),
      supabase.from("lap_bbm").select("*").gte("date", new Date(indonesia.getTime() - 7 * 86400000).toISOString().slice(0, 10)),
      supabase.from("units").select("*"),
      supabase.from("operators").select("*"),
      supabase.from("app_settings").select("*"),
      supabase.from("equipment_rental").select("*"),
    ]);

    const timeSheet = tsRes.data || [];
    const workTypes = wtRes.data || [];
    const breakdowns = bdRes.data || [];
    const lapBbm = bbmRes.data || [];
    const units = unitsRes.data || [];
    const settings = settingsRes.data || [];
    const rentals = rentalRes.data || [];

    const wtLookup: Record<string, any> = {};
    workTypes.forEach((w: any) => { wtLookup[w.site + "|" + w.work_name] = w; });

    const unitClassLookup: Record<string, string> = {};
    units.forEach((u: any) => { if (u.unit_class) unitClassLookup[u.unit_code] = u.unit_class; });

    const rentalLookup: Record<string, number> = {};
    rentals.forEach((r: any) => { rentalLookup[r.site + "|" + r.unit_class] = parseFloat(r.rate_per_hm) || 0; });

    const settingsLookup: Record<string, string> = {};
    settings.forEach((s: any) => { settingsLookup[s.key] = s.value; });

    const bbmRateMaredan = parseFloat(settingsLookup["maredan_bbm_per_liter"]) || 27000;
    const dailyFixedMaredan = parseFloat(settingsLookup["maredan_daily_cost"]) || 184000;
    const dailyFixedPrabumuli = parseFloat(settingsLookup["prabumuli_daily_cost"]) || 138000;

    const sitesWithData = new Set(timeSheet.map((e: any) => e.site));
    const sitesMissingData = ["prabumuli", "maredan"].filter(s => !sitesWithData.has(s));
    const adminNames: Record<string, string> = { prabumuli: "Ade", maredan: "Nova" };

    function aggSite(site: string) {
      const entries = timeSheet.filter((e: any) => e.site === site);
      let revenue = 0, premi = 0, bbmCost = 0, rental = 0, totalLiters = 0, totalHM = 0;
      const unitDays = new Set<string>();
      const operatorMap: Record<string, { entries: number; revenue: number; output: number }> = {};
      const workMap: Record<string, number> = {};

      entries.forEach((e: any) => {
        const wt = wtLookup[site + "|" + e.work_type];
        const out = parseFloat(e.output) || 0;
        // FIX: use correct field names — hm_allocated (smart-logic split) || hm_hours (raw)
        const liters = parseFloat(e.bbm_allocated || e.bbm_liters || 0);
        const hm = parseFloat(e.hm_allocated || e.hm_hours || 0);
        const entryRev = wt ? out * (parseFloat(wt.rate) || 0) : 0;
        const entryPremi = wt ? out * (parseFloat(wt.premi) || 0) : 0;

        revenue += entryRev;
        premi += entryPremi;
        totalLiters += liters;
        totalHM += hm;

        if (site === "maredan") {
          bbmCost += liters * bbmRateMaredan;
          const cls = unitClassLookup[e.unit_code];
          if (cls) {
            rental += hm * (rentalLookup["maredan|" + cls] || 0);
          }
        }

        unitDays.add((e.unit_code || '?') + '|' + e.date);
        workMap[e.work_type] = (workMap[e.work_type] || 0) + out;

        if (e.operator) {
          if (!operatorMap[e.operator]) operatorMap[e.operator] = { entries: 0, revenue: 0, output: 0 };
          operatorMap[e.operator].entries++;
          operatorMap[e.operator].revenue += entryRev;
          operatorMap[e.operator].output += out;
        }
      });

      const dailyRate = site === "maredan" ? dailyFixedMaredan : dailyFixedPrabumuli;
      const fixedCost = unitDays.size * dailyRate;
      const totalCost = bbmCost + premi + rental + fixedCost;
      const pnl = revenue - totalCost;
      const margin = revenue > 0 ? (pnl / revenue) * 100 : 0;

      return {
        entries: entries.length,
        unitsWorked: unitDays.size,
        totalLiters,
        totalHM,
        revenue,
        bbmCost,
        rental,
        premi,
        fixedCost,
        totalCost,
        pnl,
        margin,
      };
    }

    const prabumuli = aggSite("prabumuli");
    const maredan = aggSite("maredan");

    const activeBds = breakdowns.map((b: any) => ({
      ...b,
      days: b.start_date ? Math.floor((new Date(today).getTime() - new Date(b.start_date).getTime()) / 86400000) : 0,
    })).sort((a, b) => b.days - a.days);

    const overhaulBds = activeBds.filter((b: any) => b.days >= 14);
    const criticalBds = activeBds.filter((b: any) => b.days >= 7 && b.days < 14);

    const latestBbm: Record<string, any> = {};
    lapBbm.forEach((b: any) => {
      if (!latestBbm[b.site] || b.date > latestBbm[b.site].date) {
        latestBbm[b.site] = b;
      }
    });

    const bbmStockAlerts: any[] = [];
    ["prabumuli", "maredan"].forEach(site => {
      const stock = latestBbm[site];
      if (!stock) return;
      const saldo = parseFloat(stock.saldo) || 0;
      const recentBurn = lapBbm.filter((b: any) => b.site === site)
        .reduce((s, b: any) => s + (parseFloat(b.total_keluar) || 0), 0);
      const days = lapBbm.filter((b: any) => b.site === site).length;
      const avgBurn = days > 0 ? recentBurn / days : 0;
      const runwayDays = avgBurn > 0 ? saldo / avgBurn : 999;

      if (runwayDays < 2) {
        bbmStockAlerts.push({ site, saldo, runwayDays, avgBurn, severity: "critical" });
      } else if (runwayDays < 5) {
        bbmStockAlerts.push({ site, saldo, runwayDays, avgBurn, severity: "warning" });
      }
    });

    const fmtRp = (n: number): string => {
      if (Math.abs(n) >= 1_000_000) return `Rp ${(n / 1_000_000).toFixed(2)}M`;
      if (Math.abs(n) >= 1_000) return `Rp ${(n / 1_000).toFixed(0)}K`;
      return `Rp ${n.toFixed(0)}`;
    };
    const fmtPctSign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
    const fmtSign = (n: number) => `${n >= 0 ? "+" : "−"} ${fmtRp(Math.abs(n))}`;

    const dateLabel = new Date(reportDateStr).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    });

    function siteCard(name: string, agg: any) {
      if (agg.entries === 0) return "";
      const pnlColor = agg.pnl >= 0 ? "#16a34a" : "#dc2626";
      const marginColor = agg.margin >= 5 ? "#16a34a" : agg.margin >= 0 ? "#ea580c" : "#dc2626";

      return `
        <div style="background:#f8f8f6;border:1px solid #e5e5e0;border-radius:8px;padding:18px;margin:12px 0">
          <h3 style="margin:0 0 12px;color:#2F5496;font-size:16px">${name}</h3>
          <table style="width:100%;font-size:13px;border-collapse:collapse">
            <tr><td style="padding:4px 0;color:#666">Entries / Units worked</td><td style="text-align:right">${agg.entries} / ${agg.unitsWorked} units</td></tr>
            <tr><td style="padding:4px 0;color:#666">BBM consumed</td><td style="text-align:right">${agg.totalLiters.toFixed(0)} L (${agg.totalHM.toFixed(1)} HM)</td></tr>
            <tr><td style="padding:4px 0;color:#666">Revenue</td><td style="text-align:right;font-weight:500">${fmtRp(agg.revenue)}</td></tr>
            <tr><td style="padding:4px 0;color:#666">BBM cost</td><td style="text-align:right;color:#888">${fmtRp(agg.bbmCost)}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Equipment rental</td><td style="text-align:right;color:#888">${fmtRp(agg.rental)}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Premi + fixed</td><td style="text-align:right;color:#888">${fmtRp(agg.premi + agg.fixedCost)}</td></tr>
            <tr><td style="padding:4px 0;color:#666;border-top:1px solid #e5e5e0">Total cost</td><td style="text-align:right;border-top:1px solid #e5e5e0;font-weight:500">${fmtRp(agg.totalCost)}</td></tr>
            <tr><td style="padding:8px 0 4px;color:#1a1a1a;font-weight:600;border-top:2px solid #e5e5e0">Net P&L</td><td style="text-align:right;color:${pnlColor};font-weight:600;border-top:2px solid #e5e5e0;font-size:15px">${fmtSign(agg.pnl)}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Margin</td><td style="text-align:right;color:${marginColor};font-weight:500">${fmtPctSign(agg.margin)}</td></tr>
          </table>
        </div>`;
    }

    function alertsBlock() {
      const items: string[] = [];

      if (overhaulBds.length > 0) {
        const list = overhaulBds.slice(0, 5).map((b: any) =>
          `<li><strong>${b.unit_code}</strong> (${b.site}) — ${b.description || 'BD'} <span style="color:#dc2626">${b.days}d</span></li>`).join('');
        items.push(`<div style="background:#fef2f2;border-left:3px solid #dc2626;padding:10px 14px;margin:8px 0">
          <strong style="color:#991b1b">⚠ Overhaul decision required (≥14d standby)</strong>
          <ul style="margin:6px 0 0;padding-left:20px;font-size:13px">${list}</ul></div>`);
      }

      if (criticalBds.length > 0) {
        const list = criticalBds.slice(0, 5).map((b: any) =>
          `<li><strong>${b.unit_code}</strong> (${b.site}) — ${b.description || 'BD'} ${b.days}d</li>`).join('');
        items.push(`<div style="background:#fffbeb;border-left:3px solid #ea580c;padding:10px 14px;margin:8px 0">
          <strong style="color:#9a3412">⚠ Critical BD (7-13d)</strong>
          <ul style="margin:6px 0 0;padding-left:20px;font-size:13px">${list}</ul></div>`);
      }

      bbmStockAlerts.forEach(a => {
        const color = a.severity === "critical" ? "#dc2626" : "#ea580c";
        const bg = a.severity === "critical" ? "#fef2f2" : "#fffbeb";
        items.push(`<div style="background:${bg};border-left:3px solid ${color};padding:10px 14px;margin:8px 0">
          <strong style="color:${color}">⛽ ${a.site.charAt(0).toUpperCase() + a.site.slice(1)} BBM stock ${a.severity}</strong>
          <p style="margin:4px 0;font-size:13px">Saldo ${a.saldo.toFixed(0)} L · burn ${a.avgBurn.toFixed(0)} L/day · runway <strong>${a.runwayDays.toFixed(1)} days</strong>${a.runwayDays < 2 ? ' — <strong>Order today</strong>' : ''}</p></div>`);
      });

      if (sitesMissingData.length > 0) {
        sitesMissingData.forEach(s => {
          const admin = adminNames[s];
          const siteLabel = s.charAt(0).toUpperCase() + s.slice(1);
          items.push(`<div style="background:#fffbeb;border-left:3px solid #ea580c;padding:10px 14px;margin:8px 0">
            <strong style="color:#9a3412">📋 No ${siteLabel} data for ${reportDateStr}</strong>
            <p style="margin:4px 0;font-size:13px">No time sheet entries found for this date. ${admin} may have uploaded but with a different date range — check with them.</p></div>`);
        });
      }

      return items.length === 0
        ? '<p style="color:#16a34a">✓ No urgent alerts</p>'
        : items.join('');
    }

    const subjectPrefix = sitesMissingData.length > 0 ? "⚠ " : "";
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;line-height:1.5;padding:20px 16px">
  <h1 style="color:#2F5496;margin:0 0 4px;font-size:22px">📊 BRL Daily Digest</h1>
  <p style="color:#888;font-size:13px;margin:0 0 24px">Operations summary for ${dateLabel}</p>

  <h2 style="color:#2F5496;font-size:14px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin:28px 0 12px">Site performance</h2>
  ${siteCard("Prabumuli", prabumuli)}
  ${siteCard("Maredan", maredan)}

  <h2 style="color:#2F5496;font-size:14px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin:28px 0 12px">Urgent alerts</h2>
  ${alertsBlock()}

  <div style="margin-top:36px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:11px;color:#888">
    <a href="https://brlreplanting.netlify.app" style="color:#2F5496">View full dashboard →</a><br><br>
    Daily digest sent at 6 AM Jakarta. Reports D-2 data to allow late uploads.<br>
    Cost structure: BBM (Maredan ${fmtRp(bbmRateMaredan)}/L) + equipment rental (per HM by class) + premi + daily fixed (Maredan ${fmtRp(dailyFixedMaredan)}/unit/day).
  </div>
</body>
</html>`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [RECIPIENT_EMAIL],
        subject: `${subjectPrefix}BRL Daily Digest — ${dateLabel}`,
        html,
      }),
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      return new Response(JSON.stringify({ error: "Resend failed", details: resendData }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      report_date: reportDateStr,
      prabumuli_pnl: prabumuli.pnl,
      maredan_pnl: maredan.pnl,
      sites_missing_data: sitesMissingData,
      bbm_alerts: bbmStockAlerts.length,
      bd_alerts: overhaulBds.length + criticalBds.length,
      resend_id: resendData.id,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
