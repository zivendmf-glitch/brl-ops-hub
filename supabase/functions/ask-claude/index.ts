// BRL Ask Claude Edge Function — v4
//  • Feeds Claude PRE-AGGREGATED data (monthly-by-work-type + per-unit totals)
//    instead of 100 raw rows, so totals/averages are accurate.
//  • Supports image attachments.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_IMG = ["image/png", "image/jpeg", "image/gif", "image/webp"];
function buildUserContent(question: string, images: any[]) {
  const content: any[] = [];
  if (question && question.trim()) content.push({ type: "text", text: question });
  if (Array.isArray(images)) {
    for (const img of images.slice(0, 5)) {
      if (img && img.data && ALLOWED_IMG.includes(img.media_type)) {
        content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
      }
    }
  }
  if (content.length === 0) content.push({ type: "text", text: question || "" });
  return content;
}

const num = (v: any) => (typeof v === "number" ? v : parseFloat(v)) || 0;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { question, images } = await req.json();
    const hasImages = Array.isArray(images) && images.length > 0;
    if ((!question || question.trim().length === 0) && !hasImages) {
      return new Response(JSON.stringify({ error: "Question or image required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid auth", details: authError?.message }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) {
      return new Response(JSON.stringify({ error: "Profile not found for user " + user.id }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!["manager", "hq_admin", "viewer"].includes(profile.role)) {
      return new Response(JSON.stringify({ error: "Access denied. Role: " + profile.role }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const now = new Date();
    const indonesia = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const today = indonesia.toISOString().slice(0, 10);
    const year = today.slice(0, 4);
    const startOfYear = `${year}-01-01`;

    const [tsRes, wtRes, bdRes, bbmRes, unitsRes, opsRes, obRes, settingsRes, rentalRes] = await Promise.all([
      supabase.from("time_sheet").select("*").gte("date", startOfYear),  // full year, aggregated below
      supabase.from("work_types").select("*"),
      supabase.from("breakdowns").select("*"),
      supabase.from("lap_bbm").select("*").gte("date", startOfYear),
      supabase.from("units").select("*"),
      supabase.from("operators").select("*"),
      supabase.from("opening_balance").select("*"),
      supabase.from("app_settings").select("*"),
      supabase.from("equipment_rental").select("*"),
    ]);

    const timeSheet = tsRes.data || [];
    const workTypes = wtRes.data || [];
    const breakdowns = bdRes.data || [];
    const lapBbm = bbmRes.data || [];
    const units = unitsRes.data || [];
    const operators = opsRes.data || [];
    const openingBalance = obRes.data || [];
    const settings = settingsRes.data || [];
    const rentals = rentalRes.data || [];

    const settingsLookup: Record<string, string> = {};
    settings.forEach((s: any) => { settingsLookup[s.key] = s.value; });
    const bbmRateMaredan = parseFloat(settingsLookup["maredan_bbm_per_liter"]) || 27000;
    const dailyFixedMaredan = parseFloat(settingsLookup["maredan_daily_cost"]) || 184000;
    const dailyFixedPrabumuli = parseFloat(settingsLookup["prabumuli_daily_cost"]) || 138000;
    const unitClass: Record<string, string> = {};
    units.forEach((u: any) => { if (u.unit_class) unitClass[u.unit_code] = u.unit_class; });

    // ── AGGREGATES (compact + complete — this is what fixes wrong totals) ──
    // 1) Monthly by site × work_type
    const monthly: Record<string, any> = {};
    // 2) Per-unit totals (whole year)
    const unitTot: Record<string, any> = {};
    for (const e of timeSheet) {
      const month = (e.date || "").slice(0, 7);
      const out = num(e.output), hm = num(e.hm_allocated ?? e.hm_hours), bbm = num(e.bbm_allocated ?? e.bbm_liters);

      const mk = `${e.site}|${month}|${e.work_type}`;
      if (!monthly[mk]) monthly[mk] = { site: e.site, month, work_type: e.work_type, output: 0, hm: 0, bbm: 0, days: new Set(), unitDays: new Set() };
      const m = monthly[mk];
      m.output += out; m.hm += hm; m.bbm += bbm;
      if (e.date) { m.days.add(e.date); m.unitDays.add((e.unit_code || "?") + "|" + e.date); }

      const uk = `${e.site}|${e.unit_code}`;
      if (!unitTot[uk]) unitTot[uk] = { site: e.site, unit: e.unit_code, output: 0, hm: 0, bbm: 0, days: new Set() };
      const u = unitTot[uk];
      u.output += out; u.hm += hm; u.bbm += bbm;
      if (e.date) u.days.add(e.date);
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const production_monthly = Object.values(monthly).map((m: any) => ({
      site: m.site, month: m.month, work_type: m.work_type,
      total_output: r2(m.output), total_hm: r2(m.hm), total_bbm: r2(m.bbm),
      active_days: m.days.size, unit_days: m.unitDays.size,
      avg_output_per_active_day: m.days.size ? r2(m.output / m.days.size) : 0,
      avg_output_per_unit_day: m.unitDays.size ? r2(m.output / m.unitDays.size) : 0,
    }));
    const unit_totals_ytd = Object.values(unitTot).map((u: any) => ({
      site: u.site, unit: u.unit, unit_class: unitClass[u.unit] || null,
      total_output: r2(u.output), total_hm: r2(u.hm), total_bbm: r2(u.bbm),
      active_days: u.days.size,
      liters_per_hm: u.hm ? r2(u.bbm / u.hm) : 0,
    }));

    const context = {
      today,
      note: "Use production_monthly and unit_totals_ytd for ALL totals/averages. These are exact aggregates of every time_sheet row this year. Do NOT estimate from samples.",
      total_units: units.length,
      total_operators: operators.length,
      production_monthly,        // site × month × work_type — exact
      unit_totals_ytd,           // site × unit — exact (year)
      work_types: workTypes,
      active_breakdowns: breakdowns.filter((b: any) => !b.end_date),
      bbm_stock_recent: lapBbm.slice(-30),
      units, operators, opening_balance: openingBalance,
      equipment_rental_rates: rentals,
      cost_settings: {
        bbm_per_liter_maredan: bbmRateMaredan,
        bbm_per_liter_prabumuli_excess_only: 0,
        daily_fixed_maredan: dailyFixedMaredan,
        daily_fixed_prabumuli: dailyFixedPrabumuli,
      },
    };

    const systemPrompt = `You are an AI assistant for BRL (PT Bandang Rezeki Lestari), an Indonesian land clearing & palm oil replanting contractor with two sites:

PRABUMULI (Palembang) — land clearing via a SUBCONTRACTOR. The subcontractor supplies equipment and fuel; BRL pays NO rental and only pays BBM above a contract threshold (≈0 now). Daily fixed: Rp ${dailyFixedPrabumuli.toLocaleString()}/unit/day.
MAREDAN — BRL operates directly. BBM Rp ${bbmRateMaredan.toLocaleString()}/L. Equipment rental per HM by class (SK130 145k, SK200 175k, SK70 75k, John Deere 100k, Dozer 315k). Daily fixed Rp ${dailyFixedMaredan.toLocaleString()}/unit/day.

User: ${profile.full_name || "user"} (role: ${profile.role}). Today: ${today}.

CRITICAL — DATA ACCURACY:
• For ANY total, average, or rate, use the pre-aggregated arrays \`production_monthly\` (site × month × work_type) and \`unit_totals_ytd\` (site × unit). They are EXACT sums of every row this year.
• To answer "average X per day for <work type> in <month>": find the matching production_monthly row and read avg_output_per_active_day (or compute total_output ÷ active_days). Never estimate.
• Output units differ by work type (HA, Meter, Pokok, Lubang, Unit) — never add different units together.
• Multi-unit work (work_types with is_multi_unit=true: Terasan, Jalan) splits revenue 50/50 between excavator and dozer.
• L/HM = total_bbm ÷ total_hm. L/HA = total_bbm ÷ total_output (only when output unit is HA).
• Money format "Rp X.XM"/"Rp X.XK". Match the user's language (English/Indonesian).
• Never fabricate numbers. If something isn't in the data, say so.

Operational data (JSON):
${JSON.stringify(context, null, 2)}`;

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
        messages: [{ role: "user", content: buildUserContent(question, images) }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return new Response(JSON.stringify({ error: "Claude API failed", details: claudeData }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const answer = claudeData.content?.[0]?.text || "No response generated.";
    return new Response(JSON.stringify({ success: true, answer, tokens_used: claudeData.usage }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
