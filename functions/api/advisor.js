// Cloudflare Pages Function: /api/advisor
// TokenWatch AI Advisor powered by Laggingway / InferX (Nemotron 3.5 Lightning)
// Plain-text conversational output, website-aware, IP/Cookie rate-limited (4 queries / 24h).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Advisor-Session',
  'Content-Type': 'application/json',
  'X-Robots-Tag': 'noindex',
};

// ── Quota ────────────────────────────────────────────────────────────────────
// 4 model queries per client per window. With the optional ADVISOR_QUOTA D1
// binding the window is the UTC calendar day and the count is shared by every
// edge isolate; without it the limiter is the per-isolate in-memory map below.
const ipRateMap = new Map();
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_QUERIES_PER_WINDOW = 4;

// ── Request shape limits ─────────────────────────────────────────────────────
// The widget sends one <=250-char prompt per turn and its last few turns, so
// 12 messages / 4k chars each / 12k total leaves that traffic untouched while
// stopping this endpoint being used as a bulk LLM proxy. Only the last 6
// messages are forwarded to the model regardless.
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 12000;
const FORWARDED_MESSAGE_COUNT = 6;
const ALLOWED_ROLES = new Set(['user', 'assistant']);

// Single atomic statement: insert the first query of the day or increment the
// existing count, but refuse to grow past the limit so RETURNING yields no row
// once the client is over quota. `advisor_quota_usage.count` is unambiguous
// (the stored row) next to `excluded` (the proposed one) in an upsert.
const QUOTA_UPSERT_SQL = `INSERT INTO advisor_quota_usage (ip_hash, utc_day, count)
VALUES (?, ?, 1)
ON CONFLICT(ip_hash, utc_day) DO UPDATE SET
  count = advisor_quota_usage.count + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE advisor_quota_usage.count < ?
RETURNING count`;

function cleanOldRateEntries() {
  const now = Date.now();
  for (const [ip, data] of ipRateMap.entries()) {
    if (now - data.firstSeen > RATE_LIMIT_WINDOW_MS) {
      ipRateMap.delete(ip);
    }
  }
}

function checkRateLimit(ip) {
  cleanOldRateEntries();
  const now = Date.now();
  const data = ipRateMap.get(ip) || { count: 0, firstSeen: now };

  if (now - data.firstSeen > RATE_LIMIT_WINDOW_MS) {
    data.count = 1;
    data.firstSeen = now;
    ipRateMap.set(ip, data);
    return { allowed: true, remaining: MAX_QUERIES_PER_WINDOW - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }

  if (data.count >= MAX_QUERIES_PER_WINDOW) {
    const resetMs = RATE_LIMIT_WINDOW_MS - (now - data.firstSeen);
    return { allowed: false, remaining: 0, resetMs };
  }

  data.count += 1;
  ipRateMap.set(ip, data);
  return { allowed: true, remaining: MAX_QUERIES_PER_WINDOW - data.count, resetMs: RATE_LIMIT_WINDOW_MS - (now - data.firstSeen) };
}

function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function msUntilNextUtcMidnight(nowMs) {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return nextMidnight - nowMs;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Durable quota when the optional ADVISOR_QUOTA D1 binding is provisioned.
 * Returns null to mean "not available — use the in-memory limiter", which also
 * covers a missing salt (we must never store a raw IP) and D1 failures so a
 * broken or unapplied migration degrades the quota instead of the endpoint.
 * The stored key is SHA-256(salt + ":" + ip); the salt lives in a secret.
 */
async function consumeDurableQuota(env, ip, nowMs) {
  const db = env?.ADVISOR_QUOTA;
  if (!db || typeof db.prepare !== 'function') return null;

  const salt = env?.ADVISOR_IP_SALT;
  if (!salt) {
    console.warn('Advisor quota: ADVISOR_QUOTA is bound but ADVISOR_IP_SALT is unset; using the in-memory limiter.');
    return null;
  }

  const day = utcDay(nowMs);
  const resetMs = msUntilNextUtcMidnight(nowMs);
  try {
    const ipHash = await sha256Hex(`${salt}:${ip}`);
    const row = await db
      .prepare(QUOTA_UPSERT_SQL)
      .bind(ipHash, day, MAX_QUERIES_PER_WINDOW)
      .first();

    // No row: the guarded upsert refused to increment, so the day is spent.
    if (!row) return { allowed: false, remaining: 0, resetMs };

    const count = Number(row.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('unexpected quota row');
    return { allowed: true, remaining: Math.max(0, MAX_QUERIES_PER_WINDOW - count), resetMs };
  } catch (error) {
    console.error('Advisor quota D1 error:', error?.message || error);
    return null;
  }
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), { status, headers: CORS_HEADERS });
}

function invalidParameter(error) {
  // `error` must stay a string: the widget renders it directly.
  return jsonResponse({ error, code: 'invalid_parameter' }, 400);
}

/**
 * Validate the conversation. Roles are restricted to user/assistant so a client
 * can never inject a system message ahead of the server's own prompt, and each
 * message is rebuilt with only {role, content} so no extra fields are smuggled
 * upstream. Returns { messages } or { error } for a 400.
 */
function validateMessages(value) {
  if (!Array.isArray(value)) return { error: 'Request body must include a "messages" array.' };
  if (value.length === 0) return { error: 'The "messages" array must contain at least one message.' };
  if (value.length > MAX_MESSAGES) return { error: `Too many messages: the limit is ${MAX_MESSAGES}.` };

  const messages = [];
  let totalChars = 0;
  for (let i = 0; i < value.length; i += 1) {
    const message = value[i];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { error: `messages[${i}] must be an object with role and content.` };
    }
    if (typeof message.role !== 'string' || !ALLOWED_ROLES.has(message.role)) {
      return { error: `messages[${i}].role must be "user" or "assistant".` };
    }
    if (typeof message.content !== 'string') {
      return { error: `messages[${i}].content must be a string.` };
    }
    if (!message.content.trim()) {
      return { error: `messages[${i}].content must not be empty.` };
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return { error: `messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters.` };
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    return { error: `Conversation exceeds ${MAX_TOTAL_CHARS} characters in total.` };
  }
  return { messages };
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

  // 1. Parse and validate the request before the quota is touched, so malformed
  //    traffic cannot burn a visitor's daily allowance.
  let body;
  try {
    body = await request.json();
  } catch {
    return invalidParameter('Request body must be valid JSON.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidParameter('Request body must be a JSON object.');
  }

  const validated = validateMessages(body.messages);
  if (validated.error) return invalidParameter(validated.error);
  const userMessages = validated.messages;

  // 2. Validate environment configuration
  const INFERX_BASE_URL = env?.INFERX_BASE_URL;
  const INFERX_API_KEY = env?.INFERX_API_KEY;
  const MODEL_ID = env?.INFERX_MODEL || 'Inferx-Main/nemotron-35-lightning';

  if (!INFERX_BASE_URL || !INFERX_API_KEY) {
    console.error('Advisor error: INFERX_BASE_URL or INFERX_API_KEY environment variable is not configured.');
    return jsonResponse({ error: 'Advisor service configuration missing on server.', code: 'service_unconfigured' }, 500);
  }

  // 3. Charge the quota — only requests that are about to reach the model.
  const durable = await consumeDurableQuota(env, clientIp, Date.now());
  const rate = durable || checkRateLimit(clientIp);
  if (!rate.allowed) {
    const hoursLeft = Math.ceil(rate.resetMs / (1000 * 60 * 60));
    return jsonResponse(
      {
        error: `Daily query quota reached (${MAX_QUERIES_PER_WINDOW}/${MAX_QUERIES_PER_WINDOW}). Please try again in ${hoursLeft} hours or explore the interactive tables above.`,
        code: 'quota_exceeded',
        rateLimit: { remaining: 0, resetHours: hoursLeft },
      },
      429
    );
  }

  // 4. Load live knowledge base from static asset
  let knowledgeSnippet = '';
  try {
    const knowledgeRes = await env.ASSETS.fetch(new URL('/advisor-knowledge.json', request.url));
    if (knowledgeRes.ok) {
      const kData = await knowledgeRes.json();
      
      const zdrTopList = (kData.top_zdr_models || []).slice(0, 25).map(m => {
        const intel = `Intel:${m.scores?.intelligence ?? 'unknown'}`;
        const coding = `Coding:${m.scores?.coding ?? 'unknown'}`;
        return `- ${m.name || m.id} via ${m.provider} (${m.org}): $${m.blended}/M blended [ZDR:Yes, ${intel}, ${coding}]`;
      }).join('\n');

      const providerPolicies = (kData.providers || []).slice(0, 30).map(p => {
        return `- ${p.id} (HQ:${p.headquarters}): Privacy: ${p.privacy || 'N/A'}, ToS: ${p.tos || 'N/A'}, ZDR:${p.zdr ? 'Yes' : 'Not confirmed'}`;
      }).join('\n');

      knowledgeSnippet = `LIVE DATASET EVIDENCE (TokenWatch Knowledge Base):
- Total Live Text Offerings: ${kData.stats?.total_text_models} (${kData.stats?.total_zdr_models} tagged Zero Data Retention).
- Total Providers Tracked: ${kData.stats?.total_providers}.

TOP CHEAPEST ZERO DATA RETENTION (ZDR) OFFERINGS:
These blended rates use 50% input, 0% cached input, 50% output at published input/output prices. Cache-write and storage charges are excluded. The calculator and benchmark page use their own stated mixes; do not compare these rates without matching the mix.
${zdrTopList}

PROVIDER POLICY & PRIVACY URLS:
${providerPolicies}
`;
    }
  } catch (e) {
    console.warn('Could not load advisor-knowledge.json asset:', e);
  }

  // 5. Conversational, Expert System Prompt (Plain Text Only)
  const systemPrompt = `You are the official conversational TokenWatch AI Advisor on https://tokenwatch.wyrdwerk.com.
Created by Yash Jain (Founder & Principal at WyrdWerk LLP, https://wyrdwerk.com, X: https://x.com/thelaggingway, LinkedIn: https://www.linkedin.com/in/yash-jain-65295511b/).

YOUR MISSION:
- You are a friendly, conversational AI consultant helping visitors compare LLM inference costs, benchmark quality (LiveBench / Artificial Analysis), Zero Data Retention (ZDR) privacy compliance, and provider policy URLs.
- Always answer conversationally and directly using the supplied dataset evidence. Acknowledge missing or unavailable data; never invent benchmark scores, prices, or privacy guarantees. Unknown scores are not zero, and unconfirmed ZDR does not establish retention. Confirm current provider terms before making a privacy recommendation.

${knowledgeSnippet}

CRITICAL FORMATTING INSTRUCTIONS:
- DO NOT USE ANY MARKDOWN FORMATTING.
- No asterisks (**bold** or *italic*), no markdown headers (###), no markdown tables (|---|), and no backticks.
- Use plain, clean text with simple numbered lists (1., 2., 3.) or simple dashes (-) and clean paragraphs.
- Keep the tone friendly, conversational, concise, and easy to read.
- Never output internal thinking tags (<think>...</think>).`;

  try {
    const upstreamRes = await fetch(`${INFERX_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INFERX_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: 'system', content: systemPrompt },
          ...userMessages.slice(-FORWARDED_MESSAGE_COUNT),
        ],
        // Increased token budget to 15,000 as requested
        max_tokens: 15000,
        temperature: 0.3,
        stream: false,
      }),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error('Upstream model error:', upstreamRes.status, errText);
      // The status/body may name internal hosts or account details: log it
      // server-side only and send the client a fixed message.
      return jsonResponse(
        {
          error: 'Advisor service is temporarily unavailable. Please explore the interactive tables above.',
          code: 'upstream_unavailable',
        },
        502
      );
    }

    const completion = await upstreamRes.json();
    const rawContent = completion.choices?.[0]?.message?.content;

    let cleanReply = '';
    if (typeof rawContent === 'string' && rawContent.trim()) {
      cleanReply = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    if (!cleanReply) {
      cleanReply = 'I am unable to generate an answer right now. Please explore the interactive pricing tables above!';
    }

    return jsonResponse(
      {
        reply: cleanReply,
        rateLimit: { remaining: rate.remaining, max: MAX_QUERIES_PER_WINDOW },
      },
      200
    );
  } catch (error) {
    console.error('Advisor error:', error?.message || error);
    return jsonResponse(
      { error: 'Internal error communicating with the model endpoint.', code: 'internal_error' },
      500
    );
  }
}
