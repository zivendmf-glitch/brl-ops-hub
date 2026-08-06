// BRL Weekly Smart Insights Edge Function — UPDATED with equipment rental + new cost structure
// FIX: HM field name (was reading wrong field, equipment rental was always Rp 0)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
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
    const today = indonesia.toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(indonesia.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const fourteenDaysAgo = new Date(indonesia.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const sixtyDaysAgo = new Date(indonesia.getTime() - 60 * 86400000).toISOString().slice(0, 10);

    const [tsRes, wtRes, bdRes, bbmRes, opRes, unitsRes, opsRes, settingsRes, rentalRes] = await Promise.all([
      supabase.from("time_sheet").select("*").gte("date", fourteenDaysAgo),
      supabase.from("work_types").select("*"),
      supabase.from("breakdowns").select("*").gte("start_date", sixtyDaysAgo),
      supabase.from("lap_bbm").select("*").gte("date", fourteenDaysAgo),
      supabase.from("opening_balance").select("*"),
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
    const operators = opsRes.data || [];
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

    function aggregateWeek(site: string, startDate: string, endDate: string) {
      const entries = timeSheet.filter((e: any) =>
        e.site === site && e.date >= startDate && e.date <= endDate
      );

      let revenue = 0, premi = 0, bbmCost = 0, rental = 0, bbmLiters = 0, totalHM = 0;
      const unitDays = new Set<string>();
      const operatorOutput: Record<string, { entries: number; revenue: number }> = {};
      const workOutput: Record<string, number> = {};
      const dates = new Set<string>();

      entries.forEach((e: any) => {
        const wt = wtLookup[site + "|" + e.work_type];
        const out = parseFloat(e.output) || 0;
        // FIX: use correct field names — hm_allocated (smart-logic split) || hm_hours (raw)
        const liters = parseFloat(e.bbm_allocated || e.bbm_liters || 0);
        const hm = parseFloat(e.hm_allocated || e.hm_hours || 0);
        const entryRev = wt ? out * (parseFloat(wt.rate) || 0) : 0;

        revenue += entryRev;
        if (wt) premi += out * (parseFloat(wt.premi) || 0);
        bbmLiters += liters;
        totalHM += hm;

        if (site === "maredan") {
          bbmCost += liters * bbmRateMaredan;
          const cls = unitClassLookup[e.unit_code];
          if (cls) rental += hm * (rentalLookup["maredan|" + cls] || 0);
        }

        unitDays.add((e.unit_code || '?') + '|' + e.date);
        workOutput[e.work_type] = (workOutput[e.work_type] || 0) + out;
        dates.add(e.date);

        if (e.operator) {
          if (!operatorOutput[e.operator]) operatorOutput[e.operator] = { entries: 0, revenue: 0 };
          operatorOutput[e.operator].entries++;
          operatorOutput[e.operator].revenue += entryRev;
        }
      });

      const dailyRate = site === "maredan" ? dailyFixedMaredan : dailyFixedPrabumuli;
      const fixedCost = unitDays.size * dailyRate;
      const cost = bbmCost + premi + rental + fixedCost;

      return {
        entries: entries.length,
        days_worked: dates.size,
        units_used: unitDays.size,
        revenue,
        bbm_liters: bbmLiters,
        total_hm: totalHM,
        bbm_cost: bbmCost,
        rental_cost: rental,
        premi,
        fixed_cost: fixedCost,
        total_cost: cost,
        estimated_pnl: revenue - cost,
        margin_pct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
        bbm_pct_of_cost: cost > 0 ? (bbmCost / cost) * 100 : 0,
        rental_pct_of_cost: cost > 0 ? (rental / cost) * 100 : 0,
        l_per_hm: totalHM > 0 ? bbmLiters / totalHM : 0,
        work_breakdown: workOutput,
        top_operators: Object.entries(operatorOutput)
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .slice(0, 5)
          .map(([name, data]) => ({ name, entries: data.entries, revenue: data.revenue })),
      };
    }

    const lastWeekEnd = new Date(indonesia.getTime() - 8 * 86400000).toISOString().slice(0, 10);
    const prabumuliThisWeek = aggregateWeek("prabumuli", sevenDaysAgo, today);
    const prabumuliLastWeek = aggregateWeek("prabumuli", fourteenDaysAgo, lastWeekEnd);
    const maredanThisWeek = aggregateWeek("maredan", sevenDaysAgo, today);
    const maredanLastWeek = aggregateWeek("maredan", fourteenDaysAgo, lastWeekEnd);

    const activeBds = breakdowns.filter((b: any) => !b.end_date).map((b: any) => ({
      unit: b.unit_code, site: b.site, type: b.unit_type,
      issue: b.description, action: b.action,
      days_active: b.start_date
        ? Math.floor((new Date(today).getTime() - new Date(b.start_date).getTime()) / 86400000) : 0,
    }));

    const closedBds = breakdowns.filter((b: any) => b.end_date).map((b: any) => ({
      unit: b.unit_code, site: b.site, issue: b.description,
      start_date: b.start_date, end_date: b.end_date,
      duration: b.start_date && b.end_date
        ? Math.floor((new Date(b.end_date).getTime() - new Date(b.start_date).getTime()) / 86400000) : 0,
    }));

    const bdsByUnit: Record<string, { count: number; site: string; total_days: number }> = {};
    [...activeBds, ...closedBds].forEach((b: any) => {
      const key = b.unit;
      if (!bdsByUnit[key]) bdsByUnit[key] = { count: 0, site: b.site, total_days: 0 };
      bdsByUnit[key].count++;
      bdsByUnit[key].total_days += b.duration || b.days_active || 0;
    });

    const mostBdProneUnits = Object.entries(bdsByUnit)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
      .map(([unit, data]) => ({ unit, ...data }));

    function bbmWeek(site: string, startDate: string, endDate: string) {
      const entries = lapBbm.filter((b: any) => b.site === site && b.date >= startDate && b.date <= endDate);
      const totalConsumed = entries.reduce((s, e: any) => s + (parseFloat(e.total_keluar) || 0), 0);
      const latestStock = entries.sort((a, b) => b.date.localeCompare(a.date))[0];
      return {
        total_consumed_liters: totalConsumed,
        days_with_data: entries.length,
        avg_daily_burn: entries.length > 0 ? totalConsumed / entries.length : 0,
        current_stock: latestStock?.saldo || 0,
      };
    }

    const analysisContext = {
      report_period: { start: sevenDaysAgo, end: today },
      cost_structure: {
        prabumuli: {
          model: "subcontractor",
          bbm_cost_to_brl: 0,
          daily_fixed_per_unit: dailyFixedPrabumuli,
          equipment_rental_to_brl: 0,
          notes: "Subcontractor owns equipment and supplies BBM"
        },
        maredan: {
          model: "direct_operations",
          bbm_per_liter: bbmRateMaredan,
          daily_fixed_per_unit: dailyFixedMaredan,
          rental_rates_per_hm: rentals.reduce((acc: any, r: any) => {
            acc[r.unit_class] = r.rate_per_hm;
            return acc;
          }, {}),
        },
      },
      sites: {
        prabumuli: {
          this_week: prabumuliThisWeek, last_week: prabumuliLastWeek,
          unit_count: units.filter((u: any) => u.site === "prabumuli").length,
          active_operators: operators.filter((o: any) => o.site === "prabumuli" && o.status === "active").length,
          bbm_this_week: bbmWeek("prabumuli", sevenDaysAgo, today),
          bbm_last_week: bbmWeek("prabumuli", fourteenDaysAgo, lastWeekEnd),
        },
        maredan: {
          this_week: maredanThisWeek, last_week: maredanLastWeek,
          unit_count: units.filter((u: any) => u.site === "maredan").length,
          active_operators: operators.filter((o: any) => o.site === "maredan" && o.status === "active").length,
          bbm_this_week: bbmWeek("maredan", sevenDaysAgo, today),
          bbm_last_week: bbmWeek("maredan", fourteenDaysAgo, lastWeekEnd),
        },
      },
      breakdowns: {
        currently_active: activeBds,
        active_count: activeBds.length,
        overhaul_required_count: activeBds.filter(b => b.days_active >= 14).length,
        most_bd_prone_units: mostBdProneUnits,
        recently_resolved_count: closedBds.filter(b => b.end_date >= sevenDaysAgo).length,
      },
    };

    const systemPrompt = `You are a senior operations analyst for BRL (PT Bandang Rezeki Lestari), an Indonesian land clearing and palm oil replanting contractor with 2 sites:

PRABUMULI: Subcontracted land clearing. BRL has limited cost exposure (no BBM, no rental). Cost = daily fixed only.
MAREDAN: Direct operations. BRL bears full cost: BBM (Rp ${bbmRateMaredan.toLocaleString()}/L) + equipment rental (per HM by class) + premi + daily fixed (Rp ${dailyFixedMaredan.toLocaleString()}/unit/day = makan + lain-lain).

You're producing a Sunday evening weekly insights briefing for Ziven (the Manager) to plan the upcoming week.

Tone: Strategic, direct, action-oriented. Concise. Honest about uncertainties.

Format (use these exact section headers):

## TOP 3 PRIORITIES FOR NEXT WEEK
3 specific actions ranked by impact, time-bound.

## PERFORMANCE WEEK-OVER-WEEK
Compare this week vs last week. Use numbers but brief. Note BBM% of cost and rental% of cost shifts.

## RISKS & ANOMALIES
Unusual data. Specific units/operators. Margin pressure points.

## OPPORTUNITIES
Patterns suggesting gains. Margin improvement levers.

## QUESTIONS TO INVESTIGATE
Things you noticed but can't explain.

Rules:
- Never fabricate. If data missing, say so.
- Use Rp X.XM / Rp X.XK
- Reference specific units/operators by name when relevant
- ↑ ↓ for percent changes
- Total under 600 words
- "No notable items this week" if section empty
- For Maredan, the cost structure is BBM-dominated (~50-65%) on production days. Watch for L/HM efficiency
- Equipment rental is variable (only when units run). Standby = no rental but daily fixed still applies

Data context:
${JSON.stringify(analysisContext, null, 2)}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: "Analyze this week's data and produce the weekly insights briefing now." }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return new Response(JSON.stringify({ error: "Claude API failed", details: claudeData }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const insights = claudeData.content?.[0]?.text || "Unable to generate insights this week.";

    function markdownToHtml(md: string): string {
      let html = md;
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.+<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
      const lines = html.split('\n');
      const processed: string[] = [];
      let inBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (inBlock) processed.push('</p>');
          inBlock = false;
          continue;
        }
        if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('</ul')) {
          if (inBlock) { processed.push('</p>'); inBlock = false; }
          processed.push(line);
        } else if (trimmed.startsWith('<li>')) {
          processed.push(line);
        } else {
          if (!inBlock) { processed.push('<p>'); inBlock = true; }
          processed.push(line);
        }
      }
      if (inBlock) processed.push('</p>');
      return processed.join('\n');
    }

    const insightsHtml = markdownToHtml(insights);
    const dateLabel = indonesia.toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; padding: 0 16px; }
  .header { padding: 28px 0 16px; border-bottom: 2px solid #2F5496; margin-bottom: 24px; }
  h1 { color: #2F5496; font-size: 24px; margin: 0 0 6px; }
  .subtitle { color: #888; font-size: 13px; }
  h2 { color: #2F5496; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-top: 28px; margin-bottom: 12px; }
  h3 { color: #555; font-size: 13px; margin-top: 18px; margin-bottom: 8px; }
  p { margin: 8px 0; font-size: 13px; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin: 5px 0; font-size: 13px; }
  strong { color: #1a1a1a; }
  code { background: #f5f5f0; padding: 1px 5px; border-radius: 3px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }
  em { color: #555; font-style: italic; }
  .footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #888; }
  a { color: #2F5496; }
</style></head>
<body>
  <div class="header">
    <h1>📊 BRL Weekly Insights</h1>
    <div class="subtitle">${dateLabel} · Strategic briefing for next week</div>
  </div>
  ${insightsHtml}
  <div class="footer">
    <a href="https://brlreplanting.netlify.app">View full dashboard →</a><br><br>
    Generated by Claude Sonnet on Sunday evening to help plan the upcoming week.<br>
    Cost model: Maredan = BBM + rental (per HM by class) + premi + daily fixed; Prabumuli = daily fixed only.
  </div>
</body></html>`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL, to: [RECIPIENT_EMAIL],
        subject: `📊 BRL Weekly Insights — ${dateLabel}`, html,
      }),
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      return new Response(JSON.stringify({ error: "Resend failed", details: resendData }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      period: { start: sevenDaysAgo, end: today },
      insights_word_count: insights.split(/\s+/).length,
      maredan_pnl_this_week: maredanThisWeek.estimated_pnl,
      prabumuli_pnl_this_week: prabumuliThisWeek.estimated_pnl,
      resend_id: resendData.id,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
