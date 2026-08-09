// Morning Briefing Edge Function — direct-feeds edition
// 1) Fetch direct publisher RSS feeds (reliable, real publish dates)
// 2) Filter to the rolling window: yesterday 07:00 -> today 07:00 Jakarta (WIB)
// 3) ONE Claude (Opus 4.8) call curates + writes analysis, with a guaranteed
//    JSON schema output. Claude picks stories by index, so every URL/source/date
//    in the email is the real one from the feed — never invented.
// 4) If the Claude call fails, falls back to newest in-window headlines.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const RECIPIENT_EMAIL = "nexpain21@gmail.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Morning Briefing <onboarding@resend.dev>";

const MODEL = "claude-opus-4-8";

const PRIORITY_SOURCES = ["Bloomberg", "The Wall Street Journal", "WSJ", "Reuters", "The Economist", "Financial Times", "FT"];

// Direct publisher feeds — all verified working with fresh, dated items.
const FEEDS: { url: string; source: string; lang: "en" | "id" }[] = [
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", source: "WSJ", lang: "en" },
  { url: "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness", source: "WSJ", lang: "en" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews", source: "WSJ", lang: "en" },
  { url: "https://www.economist.com/finance-and-economics/rss.xml", source: "The Economist", lang: "en" },
  { url: "https://www.ft.com/rss/home", source: "Financial Times", lang: "en" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC", lang: "en" },
  { url: "https://www.cnbc.com/id/10001147/device/rss/rss.html", source: "CNBC", lang: "en" },
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC", lang: "en" },
  { url: "https://www.theguardian.com/business/rss", source: "The Guardian", lang: "en" },
  { url: "https://rss.tempo.co/bisnis", source: "Tempo", lang: "id" },
  { url: "https://www.cnbcindonesia.com/rss", source: "CNBC Indonesia", lang: "id" },
  { url: "https://finance.detik.com/rss", source: "Detik Finance", lang: "id" },
];

interface Candidate {
  title: string;
  description: string;
  link: string;
  source: string;
  lang: "en" | "id";
  pubDate?: Date;
  pubDateRaw?: string;
}

interface NewsItem {
  title: string;
  summary: string;
  source: string;
  link: string;
  pubDate?: string;
  isPriority: boolean;
}

// ---------- Time window (rolling 7AM -> 7AM Jakarta) ----------

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function computeWindow(now: Date) {
  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const windowEnd = new Date(jakartaNow);
  windowEnd.setUTCHours(7, 0, 0, 0);
  if (windowEnd.getTime() > jakartaNow.getTime()) {
    windowEnd.setUTCDate(windowEnd.getUTCDate() - 1);
  }
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

// Convert a "Jakarta wall-clock held in UTC fields" date back to a real instant.
function jakartaToInstant(d: Date): Date {
  return new Date(d.getTime() - JAKARTA_OFFSET_MS);
}

function jakLabel(d: Date): string {
  return d.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

// ---------- Sections ----------

interface Section {
  name: string;
  emoji: string;
  hint: string;
  count: number;
}

const SECTIONS: Section[] = [
  {
    name: "Indonesian Government Policy & Economy",
    emoji: "\u{1F1EE}\u{1F1E9}",
    hint: "Indonesian government policy, regulation, Bank Indonesia, fiscal/trade/investment policy and macro-economy.",
    count: 4,
  },
  {
    name: "Indonesian Business News",
    emoji: "\u{1F3E2}",
    hint: "Indonesian companies, earnings, deals, IDX/JCI markets, banking, commodities, sectors.",
    count: 4,
  },
  {
    name: "Indonesian & Global Politics",
    emoji: "\u{1F5F3}\u{FE0F}",
    hint: "Political developments shaping business and the economy: elections, cabinet and leadership moves, legislation, diplomacy, geopolitics and political risk — in Indonesia and globally.",
    count: 4,
  },
  {
    name: "Global Policy Impact on Economy",
    emoji: "\u{1F3DB}\u{FE0F}",
    hint: "Government policy worldwide with economic impact: tariffs, trade, central banks (Fed/ECB), regulation.",
    count: 4,
  },
  {
    name: "Global Markets & Business",
    emoji: "\u{1F4C8}",
    hint: "Global markets: indices, earnings, inflation, rates, commodities, currencies, major corporate news.",
    count: 4,
  },
  {
    name: "Hot Business & Tech Topics",
    emoji: "\u{1F525}",
    hint: "Business & technology: AI, startups, funding, big tech, disruption.",
    count: 4,
  },
];

function isPriority(source: string): boolean {
  return PRIORITY_SOURCES.some((p) => source.toLowerCase().includes(p.toLowerCase()));
}

// ---------- RSS fetching & parsing (proven approach, direct feeds) ----------

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function cleanText(text: string): string {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function fetchFeed(feed: { url: string; source: string; lang: "en" | "id" }): Promise<Candidate[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MorningBriefing/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.log(`Feed ${feed.source} (${feed.url}): HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items: Candidate[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const title = cleanText(extractTag(item, "title"));
      const description = cleanText(extractTag(item, "description")).slice(0, 220);
      const link = cleanText(extractTag(item, "link") || extractTag(item, "guid"));
      const pubDateRaw = cleanText(extractTag(item, "pubDate"));
      const parsed = pubDateRaw ? new Date(pubDateRaw) : undefined;
      const pubDate = parsed && !isNaN(parsed.getTime()) ? parsed : undefined;
      if (title) items.push({ title, description, link, source: feed.source, lang: feed.lang, pubDate, pubDateRaw });
    }
    return items;
  } catch (err) {
    console.log(`Feed ${feed.source} failed: ${err}`);
    return [];
  }
}

// ---------- Claude curation (one call, schema-guaranteed JSON) ----------

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          stories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                title: { type: "string" },
                summary: { type: "string" },
              },
              required: ["index", "title", "summary"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "stories"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
};

async function curateWithClaude(candidates: Candidate[]): Promise<NewsItem[][] | null> {
  const list = candidates.map((c, i) =>
    `[${i}] (${c.source}${c.lang === "id" ? ", Indonesian" : ""}, ${c.pubDateRaw || "recent"}) ${c.title}${c.description ? " — " + c.description : ""}`
  ).join("\n");

  const sectionSpec = SECTIONS.map((s) => `- "${s.name}": ${s.hint} (pick up to ${s.count})`).join("\n");

  const system = `You are a financial and business news analyst preparing a daily morning briefing for an Indonesian business executive.

You are given a numbered list of REAL news items fetched in the last 24 hours from trusted feeds. Curate them into the briefing sections below. Use ONLY items from the list, referenced by their index number. Never invent stories.

Sections:
${sectionSpec}

Rules:
- This executive is most interested in BUSINESS and POLITICAL/POLICY news. Weight government policy, regulation, politics, geopolitics, and major corporate/business developments most heavily. Treat routine market-index moves and lighter consumer-tech items as lower priority — include them only when genuinely significant.
- Pick the most important, decision-relevant stories for each section. Quality over quantity.
- Do not use the same item in more than one section.
- Prefer priority sources (WSJ, The Economist, Financial Times) where quality is equal.
- Indonesian-language items: write the title and summary in English.
- "title": a clean, concise English headline (you may rewrite the original).
- "summary": 2-3 analytical sentences — what happened, why it matters, and the concrete business/economic impact. For Indonesian stories, note the local relevance.
- Include every section in your output, even if its stories array is empty.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system,
        messages: [{ role: "user", content: `Curate the briefing from these ${candidates.length} items:\n\n${list}` }],
      }),
      signal: AbortSignal.timeout(110000),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`Anthropic error (${res.status}):`, JSON.stringify(data).slice(0, 400));
      return null;
    }

    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "{}";
    const obj = JSON.parse(text);
    const byName = new Map<string, any[]>(
      (obj.sections || []).map((s: any) => [String(s.name), Array.isArray(s.stories) ? s.stories : []]),
    );

    return SECTIONS.map((section) => {
      const stories = byName.get(section.name) || [];
      return stories
        .filter((s: any) => Number.isInteger(s.index) && s.index >= 0 && s.index < candidates.length)
        .slice(0, section.count)
        .map((s: any) => {
          const c = candidates[s.index];
          return {
            title: String(s.title || c.title),
            summary: String(s.summary || c.description || ""),
            source: c.source,
            link: c.link,
            pubDate: c.pubDateRaw,
            isPriority: isPriority(c.source),
          };
        });
    });
  } catch (err) {
    console.error("Claude curation failed:", err);
    return null;
  }
}

// Fallback: newest in-window items per rough bucket, no AI summaries.
function fallbackSections(candidates: Candidate[]): NewsItem[][] {
  const sorted = [...candidates].sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
  const used = new Set<number>();
  const pick = (filter: (c: Candidate) => boolean, n: number): NewsItem[] => {
    const out: NewsItem[] = [];
    for (let i = 0; i < sorted.length && out.length < n; i++) {
      if (used.has(i) || !filter(sorted[i])) continue;
      used.add(i);
      const c = sorted[i];
      out.push({
        title: c.title,
        summary: c.description || "",
        source: c.source,
        link: c.link,
        pubDate: c.pubDateRaw,
        isPriority: isPriority(c.source),
      });
    }
    return out;
  };
  return [
    pick((c) => c.lang === "id", 4),   // Indonesian Government Policy & Economy
    pick((c) => c.lang === "id", 4),   // Indonesian Business News
    pick(() => true, 4),               // Indonesian & Global Politics
    pick((c) => c.lang === "en", 4),   // Global Policy Impact on Economy
    pick((c) => c.lang === "en", 4),   // Global Markets & Business
    pick(() => true, 4),               // Hot Business & Tech Topics
  ];
}

// ---------- Hacker News ----------

async function fetchHackerNews(limit = 3): Promise<NewsItem[]> {
  try {
    const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
    const ids: number[] = await res.json();
    const stories = await Promise.all(
      ids.slice(0, 20).map((id) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json())
      ),
    );
    return stories
      .filter((s: any) => s && s.title && s.score >= 150)
      .slice(0, limit)
      .map((s: any) => ({
        title: s.title,
        summary: `${s.score} points · ${s.descendants || 0} comments on Hacker News`,
        source: "Hacker News",
        link: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        isPriority: false,
      }));
  } catch {
    return [];
  }
}

// ---------- HTML rendering ----------

function sourceBadge(source: string, priority: boolean): string {
  const bg = priority ? "#1e3a6e" : "#f0f4fa";
  const color = priority ? "#ffffff" : "#2F5496";
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;margin-bottom:6px;letter-spacing:0.3px">${source}</span>`;
}

function newsCard(items: NewsItem[]): string {
  if (items.length === 0) {
    return '<p style="color:#888;font-size:13px;font-style:italic">No stories in this window.</p>';
  }
  return items.map((item, i) => `
    <div style="margin:0 0 22px;padding:0 0 22px;${i < items.length - 1 ? "border-bottom:1px solid #f0f0ee" : ""}">
      ${sourceBadge(item.source, item.isPriority)}
      <a href="${item.link}" style="color:#1a1a1a;font-weight:600;font-size:14px;text-decoration:none;line-height:1.45;display:block;margin-bottom:6px">${item.title}</a>
      <p style="margin:0;font-size:13px;color:#444;line-height:1.6">${item.summary}</p>
      ${item.pubDate ? `<p style="margin:5px 0 0;font-size:11px;color:#bbb">${item.pubDate}</p>` : ""}
    </div>
  `).join("");
}

function sectionBlock(emoji: string, title: string, items: NewsItem[]): string {
  return `
  <h2 style="color:#1e3a6e;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;border-bottom:2px solid #e8eef6;padding-bottom:8px;margin:32px 0 18px;font-weight:700">${emoji}&nbsp; ${title}</h2>
  ${newsCard(items)}`;
}

// ---------- The job ----------

async function runBriefing(): Promise<void> {
  const now = new Date();
  const { windowStart, windowEnd } = computeWindow(now);
  const windowStartInstant = jakartaToInstant(windowStart);
  const windowLabel = `${jakLabel(windowStart)} – ${jakLabel(windowEnd)} WIB`;
  const dateLabel = windowEnd.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  console.log(`Briefing started. Window: ${windowLabel}`);

  // 1. Fetch all feeds in parallel.
  const feedResults = await Promise.all(FEEDS.map((f) => fetchFeed(f)));
  const allItems = feedResults.flat();
  console.log(`Fetched ${allItems.length} items from ${FEEDS.length} feeds.`);

  // 2. Keep items inside the window (start of window -> now, so manual runs
  //    later in the day also see the freshest news; at the 7AM cron this is
  //    exactly the 7AM->7AM cycle). Items with unparseable dates are kept.
  const cutoffMs = now.getTime() + 2 * 60 * 60 * 1000;
  const inWindow = allItems.filter((c) =>
    !c.pubDate || (c.pubDate.getTime() >= windowStartInstant.getTime() && c.pubDate.getTime() <= cutoffMs)
  );

  // 3. Cap per source to keep the prompt lean: newest 12 per source.
  const bySource = new Map<string, Candidate[]>();
  for (const c of inWindow) {
    const arr = bySource.get(c.source) || [];
    arr.push(c);
    bySource.set(c.source, arr);
  }
  const candidates: Candidate[] = [];
  for (const arr of bySource.values()) {
    arr.sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
    candidates.push(...arr.slice(0, 12));
  }
  console.log(`${candidates.length} in-window candidates after capping.`);

  // 4. Curate with Claude (or fall back to raw headlines).
  let researched = await curateWithClaude(candidates);
  if (!researched) {
    console.log("Using fallback sections (no AI summaries).");
    researched = fallbackSections(candidates);
  }

  // 5. Hacker News into Hot Topics.
  const hnItems = await fetchHackerNews(3);
  const hotIdx = SECTIONS.findIndex((s) => s.name === "Hot Business & Tech Topics");
  if (hotIdx >= 0) {
    researched[hotIdx] = [...researched[hotIdx], ...hnItems].slice(0, 5);
  }

  const totalStories = researched.reduce((sum, items) => sum + items.length, 0);
  console.log(`Curated ${totalStories} stories. Sending email...`);

  const body = SECTIONS.map((s, i) => sectionBlock(s.emoji, s.name, researched[i] || [])).join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;line-height:1.5;padding:20px 16px;background:#ffffff">

  <div style="background:linear-gradient(135deg,#0f2547,#1e3a6e);padding:28px 24px;border-radius:12px;margin-bottom:4px">
    <h1 style="color:#ffffff;margin:0 0 6px;font-size:24px;letter-spacing:-0.3px">\u{1F5DE}\u{FE0F} Morning Briefing</h1>
    <p style="color:#7aa3d4;font-size:13px;margin:0 0 4px">${dateLabel} · Jakarta Time</p>
    <p style="color:#5d86b8;font-size:11px;margin:0 0 12px">Covering ${windowLabel}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${["WSJ", "The Economist", "Financial Times", "BBC", "CNBC"].map((s) =>
        `<span style="background:rgba(255,255,255,0.12);color:#cde;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:500">${s}</span>`
      ).join("")}
      <span style="background:rgba(255,255,255,0.12);color:#cde;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:500">+ Tempo · CNBC ID · Detik</span>
    </div>
  </div>

  <div style="padding:0 2px">
    ${body}
  </div>

  <div style="margin-top:40px;padding:20px 4px 0;border-top:1px solid #e8e8e8;font-size:11px;color:#bbb;text-align:center;line-height:2">
    Morning Briefing · Daily at 7 AM Jakarta Time<br>
    Window: ${windowLabel} (rolling 7AM → 7AM)<br>
    Direct publisher feeds · curated &amp; analysed by Claude (Opus 4.8)<br>
    <span style="color:#ddd">${totalStories} stories today</span>
  </div>

</body>
</html>`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [RECIPIENT_EMAIL],
      subject: `\u{1F5DE}\u{FE0F} Morning Briefing — ${dateLabel}`,
      html,
    }),
  });

  const resendData = await resendRes.json();
  if (!resendRes.ok) {
    console.error("Resend failed:", JSON.stringify(resendData));
  } else {
    console.log(`Email sent! resend_id: ${resendData.id}, stories: ${totalStories}`);
  }
}

// ---------- Handler: respond immediately, work in background ----------

Deno.serve((_req) => {
  // @ts-ignore - EdgeRuntime is provided by the Supabase edge runtime
  EdgeRuntime.waitUntil(
    runBriefing().catch((err) => console.error("Briefing failed:", err)),
  );

  return new Response(
    JSON.stringify({ success: true, status: "briefing started" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
