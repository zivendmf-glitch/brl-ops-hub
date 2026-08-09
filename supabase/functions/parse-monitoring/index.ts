// BRL parse-monitoring — reads a photo of the client's MONITORING REPLANTING
// table with Claude vision and returns { as_of, rows:[{work_name, ha, qty}] }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { image } = await req.json();
    if (!image?.data || !image?.media_type) return json({ error: "image required" }, 400);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No authorization header" }, 401);
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: "Invalid auth" }, 401);

    const prompt = `This photo shows an Indonesian palm-oil replanting monitoring table ("MONITORING REPLANTING"). Extract:
1. The date near the title (e.g. "Tgl : 03-Jul-26") as ISO YYYY-MM-DD (year 20xx).
2. From the REALISASI SDBI columns ONLY (not RENC, not REALISASI HI): every work row with its HA value and its METER/PKK value.
Indonesian number format: dots are thousands separators, commas are decimals ("545.706" = 545706, "581,29" = 581.29).
Reply with ONLY this JSON, no other text:
{"as_of":"YYYY-MM-DD","rows":[{"work_name":"Chiping","ha":713.5,"qty":93202}, ...]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: prompt },
        ]}],
      }),
    });
    const data = await res.json();
    if (!res.ok) return json({ error: "Claude API failed", details: data }, 500);
    const text = data.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "No JSON in model reply", raw: text }, 500);
    return json(JSON.parse(m[0]));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
