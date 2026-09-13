// Morning Briefing Edge Function — v2 (2026-09-13)
//
// Indonesia is covered from three angles: domestic reporting, global forces
// with a channel into Indonesia, and how the foreign press reads Indonesia.
// Same shape as v1 (direct RSS feeds → one schema-guaranteed Claude call →
// Resend), with the quality levers turned up:
//  • More and better feeds: Bloomberg (markets/economics/politics), Nikkei Asia,
//    SCMP economy, CNA business, Kontan industri, Katadata, Economist business,
//    plus Google News searches for palm oil / sawit / CPO, industrial diesel
//    (Solar industri) prices, and Reuters' Indonesia coverage.
//  • Claude sees up to ~500 chars of each item (content:encoded when present)
//    instead of 220, so summaries rest on more than a headline.
//  • New section: Palm Oil, Fuel & Plantation Sector — the reader runs a
//    land-clearing / replanting contractor, so CPO, levies, biodiesel policy,
//    diesel prices and plantation news get their own slot.
//  • "Three things to know" at the top, a live market strip (USD/IDR, JCI,
//    Brent, gold, S&P 500), and a one-line "For BRL" angle on stories where it
//    genuinely applies.
//  • Duplicate-event merging across outlets; stricter freshness and relevance.
//  • Model: claude-opus-5 (adaptive thinking), server-side refusal fallback,
//    automatic retry without the beta if the API rejects it.
//
// Claude still picks stories by index, so every URL/source/date is the real
// one from the feed — never invented. If the Claude call fails, falls back to
// newest in-window headlines.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const RECIPIENT_EMAIL = "nexpain21@gmail.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Morning Briefing <onboarding@resend.dev>";

const MODEL = "claude-opus-5";
const MODEL_LABEL = "Claude Opus 5";
const EFFORT = "medium";               // keeps the call inside the edge-function time budget

const PRIORITY_SOURCES = ["Bloomberg", "The Wall Street Journal", "WSJ", "Reuters", "The Economist", "Financial Times", "FT", "Nikkei Asia"];

// ---------- Feeds ----------
// cap = newest N in-window items kept from this feed (keeps the prompt lean).
// kind "gnews" = Google News search feed: the real outlet comes from <source>.
interface Feed { url: string; source: string; lang: "en" | "id"; cap?: number; kind?: "gnews" }

const FEEDS: Feed[] = [
  // Global priority
  { url: "https://feeds.bloomberg.com/markets/news.rss", source: "Bloomberg", lang: "en" },
  { url: "https://feeds.bloomberg.com/economics/news.rss", source: "Bloomberg", lang: "en" },
  { url: "https://feeds.bloomberg.com/politics/news.rss", source: "Bloomberg", lang: "en", cap: 8 },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", source: "WSJ", lang: "en" },
  { url: "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness", source: "WSJ", lang: "en" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews", source: "WSJ", lang: "en" },
  { url: "https://www.economist.com/finance-and-economics/rss.xml", source: "The Economist", lang: "en" },
  { url: "https://www.economist.com/business/rss.xml", source: "The Economist", lang: "en", cap: 8 },
  { url: "https://www.ft.com/rss/home", source: "Financial Times", lang: "en" },
  // Asia
  { url: "https://asia.nikkei.com/rss/feed/nar", source: "Nikkei Asia", lang: "en" },
  { url: "https://www.scmp.com/rss/92/feed", source: "SCMP", lang: "en", cap: 8 },
  { url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511", source: "CNA", lang: "en", cap: 8 },
  // Global general
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC", lang: "en" },
  { url: "https://www.cnbc.com/id/10001147/device/rss/rss.html", source: "CNBC", lang: "en" },
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC", lang: "en" },
  { url: "https://www.theguardian.com/business/rss", source: "The Guardian", lang: "en", cap: 8 },
  // Indonesia
  { url: "https://rss.tempo.co/bisnis", source: "Tempo", lang: "id" },
  { url: "https://www.cnbcindonesia.com/rss", source: "CNBC Indonesia", lang: "id" },
  { url: "https://finance.detik.com/rss", source: "Detik Finance", lang: "id" },
  { url: "https://industri.kontan.co.id/rss", source: "Kontan", lang: "id" },
  { url: "https://katadata.co.id/rss", source: "Katadata", lang: "id", cap: 8 },
  // Sector searches (Google News) — outlet name comes from the item itself
  { url: "https://news.google.com/rss/search?q=%22palm+oil%22+OR+CPO+OR+biodiesel+when:1d&hl=en-ID&gl=ID&ceid=ID:en", source: "Google News", lang: "en", cap: 10, kind: "gnews" },
  { url: "https://news.google.com/rss/search?q=sawit+OR+CPO+OR+%22minyak+sawit%22+OR+biodiesel+when:1d&hl=id&gl=ID&ceid=ID:id", source: "Google News", lang: "id", cap: 10, kind: "gnews" },
  { url: "https://news.google.com/rss/search?q=%22solar+industri%22+OR+%22harga+solar%22+OR+%22BBM+industri%22+OR+%22alat+berat%22+when:2d&hl=id&gl=ID&ceid=ID:id", source: "Google News", lang: "id", cap: 8, kind: "gnews" },
  { url: "https://news.google.com/rss/search?q=site:reuters.com+Indonesia+when:1d&hl=en-ID&gl=ID&ceid=ID:en", source: "Reuters", lang: "en", cap: 10, kind: "gnews" },
  // Foreign press on Indonesia — feeds the "Indonesia Through Foreign Eyes" section
  { url: "https://news.google.com/rss/search?q=(Indonesia+economy+OR+rupiah+OR+%22Bank+Indonesia%22+OR+Prabowo+OR+Jakarta)+(site:bloomberg.com+OR+site:reuters.com+OR+site:ft.com+OR+site:economist.com+OR+site:wsj.com+OR+site:asia.nikkei.com+OR+site:scmp.com)+when:2d&hl=en-ID&gl=ID&ceid=ID:en", source: "Foreign press", lang: "en", cap: 14, kind: "gnews" },
  { url: "https://news.google.com/rss/search?q=Indonesia+(site:bloomberg.com+OR+site:ft.com+OR+site:economist.com+OR+site:wsj.com+OR+site:asia.nikkei.com+OR+site:channelnewsasia.com+OR+site:reuters.com)+when:1d&hl=en-ID&gl=ID&ceid=ID:en", source: "Foreign press", lang: "en", cap: 10, kind: "gnews" },
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
  brlAngle?: string;
  source: string;
  link: string;
  pubDate?: string;
  isPriority: boolean;
}

// ---------- Time window (rolling 7AM -> 7AM Jakarta) ----------

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

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

function jakStamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000 + JAKARTA_OFFSET_MS).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

// ---------- Sections ----------

interface Section { name: string; emoji: string; hint: string; count: number }

const SECTIONS: Section[] = [
  {
    name: "Indonesia: Domestic Policy & Economy",
    emoji: "\u{1F1EE}\u{1F1E9}",
    hint: "What Indonesia's own institutions and press are reporting: government policy, regulation, Bank Indonesia, fiscal/trade/investment policy, subsidies, taxes, macro data. Prefer DOMESTIC outlets (Kontan, Katadata, Detik Finance, CNBC Indonesia, Tempo); use a foreign outlet here only if no domestic item covers the story.",
    count: 4,
  },
  {
    name: "Global Forces on the Indonesian Economy",
    emoji: "\u{1F30F}",
    hint: "Developments OUTSIDE Indonesia with a specific channel into its economy: Fed/ECB/BoJ rates and the rupiah, US and China tariffs or trade rulings, China demand, oil and commodity prices, capital flows, ASEAN and regional deals. The summary must name the channel into Indonesia (rupiah, exports, fuel subsidy bill, foreign investment, rates).",
    count: 3,
  },
  {
    name: "Indonesia Through Foreign Eyes",
    emoji: "\u{1F52D}",
    hint: "How the international press is reading Indonesia's economy, policy and politics right now — ONLY items from foreign outlets (Bloomberg, Reuters, WSJ, Financial Times, The Economist, Nikkei Asia, SCMP, CNA, BBC, CNBC, The Guardian) whose subject is Indonesia. Favour analysis, investor sentiment, ratings, market commentary and policy critique over spot news; note the outlet's framing or verdict in the summary.",
    count: 3,
  },
  {
    name: "Indonesian Business News",
    emoji: "\u{1F3E2}",
    hint: "Indonesian companies, earnings, deals, IDX/JCI, banking, infrastructure, sectors (excluding palm oil, which has its own section).",
    count: 4,
  },
  {
    name: "Palm Oil, Fuel & Plantation Sector",
    emoji: "\u{1F334}",
    hint: "CPO prices and exports, export levy / DMO, B40-B50 biodiesel, EUDR and sustainability rules, replanting (PSR) programmes, plantation companies, industrial diesel (Solar industri) and fuel pricing, heavy-equipment and contractor news, weather/El Niño affecting estates.",
    count: 4,
  },
  {
    name: "Indonesian & Global Politics",
    emoji: "\u{1F5F3}\u{FE0F}",
    hint: "Political developments shaping business and the economy: cabinet and leadership moves, legislation, elections, diplomacy, geopolitics and political risk — in Indonesia and globally.",
    count: 3,
  },
  {
    name: "Global Markets & Business",
    emoji: "\u{1F4C8}",
    hint: "Global markets: rates, inflation, commodities (oil especially), currencies, major corporate news. Skip routine index moves unless something drove them.",
    count: 4,
  },
  {
    name: "Hot Business & Tech Topics",
    emoji: "\u{1F525}",
    hint: "Business & technology: AI, startups, funding, big tech, disruption — substantive developments, not product reviews.",
    count: 3,
  },
];

const PALM_SECTION = "Palm Oil, Fuel & Plantation Sector";
const HOT_SECTION = "Hot Business & Tech Topics";

function isPriority(source: string): boolean {
  return PRIORITY_SOURCES.some((p) => source.toLowerCase().includes(p.toLowerCase()));
}

// ---------- RSS fetching & parsing ----------

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
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’").replace(/&#8216;/g, "‘").replace(/&#8220;/g, "“").replace(/&#8221;/g, "”")
    .replace(/\s+/g, " ").trim();
}

const DESC_MAX = 500;

async function fetchFeed(feed: Feed): Promise<Candidate[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MorningBriefing/2.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.log(`Feed ${feed.source} (${feed.url}): HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items: Candidate[] = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/g;   // also matches RDF <item rdf:about="..."> (Nikkei)
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      let title = cleanText(extractTag(item, "title"));
      let source = feed.source;
      let description = "";
      if (feed.kind === "gnews") {
        // Google News: "<headline> - <Outlet>" titles, outlet in <source>, description is just a link.
        const src = cleanText(extractTag(item, "source"));
        if (src) source = src;
        const dash = title.lastIndexOf(" - ");
        if (dash > 0) title = title.slice(0, dash).trim();
        if (feed.source === "Reuters") source = "Reuters";
        source = source.replace(/\.com$/i, "").replace(/^economist$/i, "The Economist");
        if (title.length < 28) continue;   // section pages and index stubs, not articles
      } else {
        const enc = cleanText(extractTag(item, "content:encoded"));
        const desc = cleanText(extractTag(item, "description"));
        description = (enc.length > desc.length ? enc : desc).slice(0, DESC_MAX);
        if (description.length === DESC_MAX) description = description.replace(/\s+\S*$/, "") + "…";
      }
      const link = cleanText(extractTag(item, "link") || extractTag(item, "guid"));
      const pubDateRaw = cleanText(extractTag(item, "pubDate") || extractTag(item, "dc:date") || extractTag(item, "published"));
      const parsed = pubDateRaw ? new Date(pubDateRaw) : undefined;
      const pubDate = parsed && !isNaN(parsed.getTime()) ? parsed : undefined;
      if (title && link) items.push({ title, description, link, source, lang: feed.lang, pubDate, pubDateRaw });
    }
    return items;
  } catch (err) {
    console.log(`Feed ${feed.source} failed: ${err}`);
    return [];
  }
}

// ---------- Market snapshot (Yahoo Finance chart endpoint, best-effort) ----------

interface Quote { label: string; value: string; change: number | null; asOf: string }

async function fetchQuote(symbol: string, label: string, fmt: (n: number) => string): Promise<Quote | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const t = Number(meta?.regularMarketTime);
    if (!isFinite(price) || !t) return null;
    // Ignore quotes older than 4 days (a dead symbol keeps returning a stale print).
    if (Date.now() / 1000 - t > 4 * 86400) return null;
    return { label, value: fmt(price), change: isFinite(prev) && prev > 0 ? ((price - prev) / prev) * 100 : null, asOf: jakStamp(t) };
  } catch {
    return null;
  }
}

async function fetchMarkets(): Promise<Quote[]> {
  const n0 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const n2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const quotes = await Promise.all([
    fetchQuote("IDR=X", "USD/IDR", n0),
    fetchQuote("^JKSE", "JCI", n0),
    fetchQuote("BZ=F", "Brent", (n) => "$" + n2(n)),
    fetchQuote("GC=F", "Gold", (n) => "$" + n0(n)),
    fetchQuote("^GSPC", "S&P 500", n0),
  ]);
  return quotes.filter((q): q is Quote => q !== null);
}

// ---------- Claude curation (one call, schema-guaranteed JSON) ----------

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    top_takeaways: {
      type: "array",
      items: { type: "string" },
    },
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
                brl_angle: { type: "string" },
              },
              required: ["index", "title", "summary", "brl_angle"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "stories"],
        additionalProperties: false,
      },
    },
  },
  required: ["top_takeaways", "sections"],
  additionalProperties: false,
};

interface Curated { sections: NewsItem[][]; takeaways: string[] }

function buildSystemPrompt(windowLabel: string): string {
  const sectionSpec = SECTIONS.map((s) => `- "${s.name}" (up to ${s.count}): ${s.hint}`).join("\n");
  return `You are the editor of a daily morning briefing for one reader: a manager at PT Bandang Rezeki Lestari (BRL), an Indonesian land-clearing and oil-palm replanting contractor. BRL runs excavators and bulldozers on plantation estates in Riau and South Sumatra. Its revenue depends on plantation companies' replanting budgets, which follow CPO prices, export levies, biodiesel mandates and government replanting (PSR) funding; its biggest costs are industrial diesel (Solar industri), equipment rental, operator premi and spare parts. He follows Indonesian policy and politics closely and reads Bloomberg/WSJ/FT-level international coverage.

You receive a numbered list of REAL items published in the window ${windowLabel}, fetched from trusted feeds. Curate them into the sections below. Use ONLY items from the list, referenced by index. Never invent a story, number, quote or date. If an item's text is thin, write a shorter summary rather than padding it.

Sections:
${sectionSpec}

Editorial standard:
- The first three sections are three lenses on Indonesia and must not overlap: domestic reporting goes in "Domestic Policy & Economy"; a foreign development with a channel into Indonesia goes in "Global Forces"; a foreign outlet's own reporting or analysis ABOUT Indonesia goes in "Through Foreign Eyes". Check the outlet in the item's parentheses before placing it.
- Pick for consequence, not volume. A section with two strong stories beats four weak ones. Leave a section empty if nothing in the window earns a place.
- One event, one story. When several outlets cover the same development, pick the best-sourced item (prefer Bloomberg, WSJ, Reuters, FT, The Economist, Nikkei Asia when quality is equal) and do not use the others.
- Freshness: prefer items dated inside the window; treat undated items as recent only if the content is clearly new.
- Skip listicles, explainers with no new facts, sponsored content, lifestyle, sport, celebrity, product reviews and generic "stocks rose" pieces.
- Indonesian-language items: write title and summary in English. Keep Indonesian proper nouns (ministries, programmes, company names) as they are.
- "title": clean, specific, at most 90 characters; you may rewrite the original.
- "summary": 2-3 sentences. First what happened, with the concrete numbers that are in the item (amounts, percentages, dates). Then why it matters and what to watch next. Plain, direct English; no filler phrases.
- "brl_angle": one short sentence on what this means for a replanting/land-clearing contractor (fuel cost, equipment, plantation clients' spending, CPO/levy/biodiesel, rupiah, rates, labour rules, weather). Use it only when the link is real and specific; otherwise return an empty string. Most stories should have an empty brl_angle.
- "top_takeaways": exactly three one-sentence takeaways for the whole morning, most consequential first, written for this reader. They may reference stories from any section.
- Do not use the same item in more than one section. Include every section in the output, even when its stories array is empty.`;
}

async function callClaude(system: string, user: string, withFallback: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 12000,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system,
    messages: [{ role: "user", content: user }],
  };
  if (withFallback) {
    // Server-side refusal fallback: if the model declines, Anthropic re-runs on
    // its recommended substitute instead of returning an empty briefing.
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(115000),
  });
}

async function curateWithClaude(candidates: Candidate[], windowLabel: string): Promise<Curated | null> {
  const list = candidates.map((c, i) =>
    `[${i}] (${c.source}${c.lang === "id" ? ", Indonesian" : ""}, ${c.pubDateRaw || "undated"}) ${c.title}${c.description ? " — " + c.description : ""}`
  ).join("\n");
  const system = buildSystemPrompt(windowLabel);
  const user = `Curate this morning's briefing from these ${candidates.length} items:\n\n${list}`;

  try {
    let res = await callClaude(system, user, true);
    if (res.status === 400) {
      // Most likely the fallback beta was not accepted on this account/model — retry plainly.
      const errText = await res.text();
      console.log(`Anthropic 400 with fallback beta, retrying without it: ${errText.slice(0, 200)}`);
      res = await callClaude(system, user, false);
    }
    const data = await res.json();
    if (!res.ok) {
      console.error(`Anthropic error (${res.status}):`, JSON.stringify(data).slice(0, 400));
      return null;
    }
    if (data.stop_reason === "refusal") {
      console.error("Anthropic refusal:", JSON.stringify(data.stop_details || {}).slice(0, 200));
      return null;
    }
    if (data.stop_reason === "max_tokens") console.log("Warning: output hit max_tokens; JSON may be truncated.");
    if (data.usage) console.log(`Claude usage: in=${data.usage.input_tokens} out=${data.usage.output_tokens}`);

    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "{}";
    const obj = JSON.parse(text);
    const byName = new Map<string, any[]>(
      (obj.sections || []).map((s: any) => [String(s.name), Array.isArray(s.stories) ? s.stories : []]),
    );
    const used = new Set<number>();
    const sections = SECTIONS.map((section) => {
      const stories = byName.get(section.name) || [];
      const out: NewsItem[] = [];
      for (const s of stories) {
        if (!Number.isInteger(s.index) || s.index < 0 || s.index >= candidates.length || used.has(s.index)) continue;
        if (out.length >= section.count) break;
        used.add(s.index);
        const c = candidates[s.index];
        out.push({
          title: String(s.title || c.title),
          summary: String(s.summary || c.description || ""),
          brlAngle: String(s.brl_angle || "").trim() || undefined,
          source: c.source,
          link: c.link,
          pubDate: c.pubDateRaw,
          isPriority: isPriority(c.source),
        });
      }
      return out;
    });
    const takeaways = (Array.isArray(obj.top_takeaways) ? obj.top_takeaways : []).map((t: any) => String(t).trim()).filter(Boolean).slice(0, 3);
    return { sections, takeaways };
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
      out.push({ title: c.title, summary: c.description || "", source: c.source, link: c.link, pubDate: c.pubDateRaw, isPriority: isPriority(c.source) });
    }
    return out;
  };
  const palm = /sawit|palm|cpo|biodiesel|solar industri|plantation|perkebunan/i;
  const indo = /indonesia|jakarta|rupiah|prabowo/i;
  return SECTIONS.map((s) => {
    if (s.name === PALM_SECTION) return pick((c) => palm.test(c.title + " " + c.description), s.count);
    if (s.name === "Indonesia Through Foreign Eyes") return pick((c) => c.lang === "en" && indo.test(c.title + " " + c.description), s.count);
    if (s.name.startsWith("Indonesia")) return pick((c) => c.lang === "id", s.count);
    return pick((c) => c.lang === "en", s.count);
  });
}

// ---------- Hacker News (light touch: two genuinely big threads at most) ----------

async function fetchHackerNews(limit = 2): Promise<NewsItem[]> {
  try {
    const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", { signal: AbortSignal.timeout(8000) });
    const ids: number[] = await res.json();
    const stories = await Promise.all(
      ids.slice(0, 15).map((id) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null)
      ),
    );
    return stories
      .filter((s: any) => s && s.title && s.score >= 250 && s.url)
      .slice(0, limit)
      .map((s: any) => ({
        title: s.title,
        summary: `${s.score} points · ${s.descendants || 0} comments on Hacker News`,
        source: "Hacker News",
        link: s.url,
        isPriority: false,
      }));
  } catch {
    return [];
  }
}

// ---------- HTML rendering ----------

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sourceBadge(source: string, priority: boolean): string {
  const bg = priority ? "#1e3a6e" : "#f0f4fa";
  const color = priority ? "#ffffff" : "#2F5496";
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;margin-bottom:6px;letter-spacing:0.3px">${esc(source)}</span>`;
}

function newsCard(items: NewsItem[]): string {
  if (items.length === 0) {
    return '<p style="color:#888;font-size:13px;font-style:italic">Nothing in this window earned a place.</p>';
  }
  return items.map((item, i) => `
    <div style="margin:0 0 22px;padding:0 0 22px;${i < items.length - 1 ? "border-bottom:1px solid #f0f0ee" : ""}">
      ${sourceBadge(item.source, item.isPriority)}
      <a href="${esc(item.link)}" style="color:#1a1a1a;font-weight:600;font-size:14px;text-decoration:none;line-height:1.45;display:block;margin-bottom:6px">${esc(item.title)}</a>
      <p style="margin:0;font-size:13px;color:#444;line-height:1.6">${esc(item.summary)}</p>
      ${item.brlAngle ? `<p style="margin:6px 0 0;font-size:12px;color:#166534;line-height:1.5;background:#f0fdf4;border-left:2px solid #86efac;padding:4px 8px">\u{1F334} <strong>For BRL:</strong> ${esc(item.brlAngle)}</p>` : ""}
      ${item.pubDate ? `<p style="margin:5px 0 0;font-size:11px;color:#bbb">${esc(item.pubDate)}</p>` : ""}
    </div>
  `).join("");
}

function sectionBlock(emoji: string, title: string, items: NewsItem[]): string {
  return `
  <h2 style="color:#1e3a6e;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;border-bottom:2px solid #e8eef6;padding-bottom:8px;margin:32px 0 18px;font-weight:700">${emoji}&nbsp; ${esc(title)}</h2>
  ${newsCard(items)}`;
}

function takeawaysBlock(takeaways: string[]): string {
  if (!takeaways.length) return "";
  return `
  <div style="background:#f8f8f6;border:1px solid #e5e5e0;border-radius:10px;padding:16px 18px;margin:16px 0 4px">
    <div style="font-size:11px;color:#1e3a6e;font-weight:700;text-transform:uppercase;letter-spacing:1.3px;margin-bottom:8px">Three things to know</div>
    <ol style="margin:0;padding-left:20px;font-size:13.5px;color:#1a1a1a;line-height:1.6">
      ${takeaways.map((t) => `<li style="margin-bottom:6px">${esc(t)}</li>`).join("")}
    </ol>
  </div>`;
}

function marketsBlock(quotes: Quote[]): string {
  if (!quotes.length) return "";
  const cell = (q: Quote) => {
    const ch = q.change === null ? "" : `<div style="font-size:11px;color:${q.change >= 0 ? "#15803d" : "#b91c1c"}">${q.change >= 0 ? "▲" : "▼"} ${Math.abs(q.change).toFixed(2)}%</div>`;
    return `<td style="padding:8px 6px;text-align:center;vertical-align:top">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">${esc(q.label)}</div>
      <div style="font-size:15px;font-weight:700;color:#1a1a1a">${esc(q.value)}</div>${ch}</td>`;
  };
  const asOf = quotes.map((q) => q.asOf).sort().pop();
  return `
  <table style="width:100%;border-collapse:collapse;border:1px solid #e5e5e0;border-radius:10px;margin:12px 0 4px"><tr>${quotes.map(cell).join("")}</tr></table>
  <p style="margin:2px 0 0;font-size:10px;color:#bbb;text-align:right">Yahoo Finance · latest print ${esc(asOf)} WIB · change vs previous close</p>`;
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

  // 1. Fetch all feeds + market quotes in parallel.
  const [feedResults, quotes] = await Promise.all([
    Promise.all(FEEDS.map((f) => fetchFeed(f))),
    fetchMarkets(),
  ]);
  const allItems = feedResults.flat();
  console.log(`Fetched ${allItems.length} items from ${FEEDS.length} feeds; ${quotes.length} market quotes.`);

  // 2. Keep items inside the window (start -> now + slack). Undated items are kept.
  const cutoffMs = now.getTime() + 2 * 60 * 60 * 1000;
  const inWindowByFeed = feedResults.map((items) =>
    items.filter((c) => !c.pubDate || (c.pubDate.getTime() >= windowStartInstant.getTime() && c.pubDate.getTime() <= cutoffMs))
  );

  // 3. Cap per FEED (newest first), then drop exact-duplicate links/titles across feeds.
  const seenLink = new Set<string>();
  const seenTitle = new Set<string>();
  const candidates: Candidate[] = [];
  inWindowByFeed.forEach((items, fi) => {
    const cap = FEEDS[fi].cap ?? 12;
    items.sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
    for (const c of items.slice(0, cap)) {
      const linkKey = c.link.replace(/[?#].*$/, "").toLowerCase();
      const titleKey = c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenLink.has(linkKey) || seenTitle.has(titleKey)) continue;
      seenLink.add(linkKey); seenTitle.add(titleKey);
      candidates.push(c);
    }
  });
  console.log(`${candidates.length} in-window candidates after capping.`);

  // 4. Curate with Claude (or fall back to raw headlines).
  const curated = await curateWithClaude(candidates, windowLabel);
  let sections: NewsItem[][];
  let takeaways: string[] = [];
  let curatedBy = `curated & analysed by ${MODEL_LABEL}`;
  if (curated) {
    sections = curated.sections;
    takeaways = curated.takeaways;
  } else {
    console.log("Using fallback sections (no AI summaries).");
    sections = fallbackSections(candidates);
    curatedBy = "headlines only — AI curation unavailable this morning";
  }

  // 5. Hacker News into Hot Topics.
  const hnItems = await fetchHackerNews(2);
  const hotIdx = SECTIONS.findIndex((s) => s.name === HOT_SECTION);
  if (hotIdx >= 0) sections[hotIdx] = [...sections[hotIdx], ...hnItems].slice(0, 5);

  const totalStories = sections.reduce((sum, items) => sum + items.length, 0);
  const sourcesUsed = [...new Set(sections.flat().map((s) => s.source))];
  console.log(`Curated ${totalStories} stories from ${sourcesUsed.length} sources. Sending email...`);

  const body = SECTIONS.map((s, i) => sectionBlock(s.emoji, s.name, sections[i] || [])).join("");
  const chips = ["Bloomberg", "WSJ", "Reuters", "FT", "The Economist", "Nikkei Asia", "BBC", "CNBC"];
  const preheader = takeaways[0] || `${totalStories} stories · ${windowLabel}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;line-height:1.5;padding:20px 16px;background:#ffffff">
  <div style="display:none;max-height:0;overflow:hidden;color:#fff;font-size:1px">${esc(preheader)}</div>

  <div style="background:linear-gradient(135deg,#0f2547,#1e3a6e);padding:28px 24px;border-radius:12px;margin-bottom:4px">
    <h1 style="color:#ffffff;margin:0 0 6px;font-size:24px;letter-spacing:-0.3px">\u{1F5DE}\u{FE0F} Morning Briefing</h1>
    <p style="color:#7aa3d4;font-size:13px;margin:0 0 4px">${dateLabel} · Jakarta Time</p>
    <p style="color:#5d86b8;font-size:11px;margin:0 0 12px">Covering ${windowLabel}</p>
    <div>
      ${chips.map((s) => `<span style="display:inline-block;background:rgba(255,255,255,0.12);color:#cde;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:500;margin:0 4px 4px 0">${s}</span>`).join("")}
      <span style="display:inline-block;background:rgba(255,255,255,0.12);color:#cde;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:500;margin:0 4px 4px 0">+ Kontan · Katadata · Detik · CNBC ID · Tempo · sector search</span>
    </div>
  </div>

  ${takeawaysBlock(takeaways)}
  ${marketsBlock(quotes)}

  <div style="padding:0 2px">
    ${body}
  </div>

  <div style="margin-top:40px;padding:20px 4px 0;border-top:1px solid #e8e8e8;font-size:11px;color:#bbb;text-align:center;line-height:2">
    Morning Briefing · Daily at 7 AM Jakarta Time<br>
    Window: ${windowLabel} (rolling 7AM → 7AM)<br>
    ${FEEDS.length} publisher &amp; sector feeds · ${curatedBy}<br>
    <span style="color:#ddd">${totalStories} stories today from ${candidates.length} candidates</span>
  </div>

</body>
</html>`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [RECIPIENT_EMAIL],
      subject: `\u{1F5DE}\u{FE0F} Morning Briefing — ${dateLabel}${takeaways[0] ? " · " + takeaways[0].slice(0, 80) : ""}`,
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
