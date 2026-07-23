// Gemini 1.5 models were fully shut down earlier this year (every request
// now 404s), and the @google/generative-ai SDK that used to sit here is
// itself deprecated in favor of @google/genai. Both are updated below.
// Using the "gemini-flash-latest" alias (rather than pinning a dated model
// id like "gemini-3.5-flash") means Google repoints it to their current
// fast model as they retire old ones, so this endpoint shouldn't go dark
// again the next time a model is sunset — the tradeoff is that behavior can
// shift slightly whenever Google moves the alias, without a code change here.
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// This endpoint has no login step for contestants to check against (unlike
// the admin/brand areas, which use Supabase Auth), so it can't require a
// session token without locking out the people it's meant for. These are
// lighter cost-control guards instead of real auth:
//   - reject requests without a matching Origin/Referer (stops the most
//     casual off-site abuse/scraping — spoofable by a determined attacker,
//     not a security boundary)
//   - cap message length (bounds the cost of any single request)
// For real abuse protection, a per-IP or per-session rate limit (e.g. via
// a Supabase table tracking request counts) would be the next step.
const MAX_MESSAGE_LENGTH = 500;
const ALLOWED_ORIGINS = (process.env.SITE_URL ? [process.env.SITE_URL] : []);

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  if (ALLOWED_ORIGINS.length > 0) {
    const origin = event.headers.origin || event.headers.referer || '';
    const isAllowed = ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
    if (!isAllowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Forbidden" }) };
    }
  }

  try {
    const { message, siteContext } = JSON.parse(event.body);

    if (!message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Message is required" })
      };
    }

    const trimmedMessage = String(message).slice(0, MAX_MESSAGE_LENGTH);

    // Pricing is passed in from the client (state.systemConfig.votePriceCost,
    // etc.) instead of hardcoded here, so the assistant always quotes
    // whatever the site is actually charging right now — even if an admin
    // changes the vote price in the DB — rather than a stale baked-in figure.
    const votePrice = siteContext && siteContext.votePrice ? Number(siteContext.votePrice) : 250;

    const prompt = `
    You are the "M&A Pageantry Assistant", a friendly, professional AI
    embedded on the M&A Pageantry website. You help visitors — contestants,
    voters, ticket buyers, and brands — with questions about the pageant.

    Current pricing — use these exact figures, never guess or invent others:
    - Votes: ₦${votePrice} each, via Paystack, cast from the "Face of M&A Pageantry" page.
    - Tickets: General Admission ₦5,000, VIP Seating ₦15,000, VVIP Table ₦60,000.
    - Brand registration: ₦20,000 for a Marketplace storefront card.

    Rules:
    1. Be warm, concise, helpful — 2 to 4 sentences.
    2. Only answer questions about this pageant (voting, tickets, brand
       registration, contestants, general event info). If asked something
       unrelated, or something you don't have facts for, say so plainly and
       point them to the WhatsApp contact link at the bottom of the page.
    3. Never invent prices, dates, or facts not given to you here.
    4. Use at most one emoji.

    User question: ${trimmedMessage}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: prompt,
    });
    const text = response.text;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: text })
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
