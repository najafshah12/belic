const { createHmac, timingSafeEqual } = require("node:crypto");

const SYSTEM_INSTRUCTIONS = `You are Belic's WhatsApp business assistant. Help people understand Belic's business strategy, technology, growth, digital marketing, brand design, website development, and CRM/business systems services. Be warm, concise, and professional. Reply in the language the customer uses (English or Roman Urdu). Ask one clear question at a time when you need more context. Never invent prices, timelines, guarantees, client results, or services. If asked for something you cannot confirm, say a Belic team member can clarify. When a customer is ready, ask for their name, business, and best contact details, then tell them the team can follow up at belic.info.pk@gmail.com. Do not claim to be human.`;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  let size = 0;
  for await (const incoming of req) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Webhook payload exceeded the 1 MB limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing server environment variables: ${missing.join(", ")}`);
}

async function redisCommand(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Conversation store returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error("Conversation store request failed");
  return result.result;
}

async function createReply(sender, text) {
  const previousId = await redisCommand("GET", `belic:wa:conversation:${sender}`);
  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-6-astra",
    instructions: SYSTEM_INSTRUCTIONS,
    input: [{ role: "user", content: text }],
    max_output_tokens: 240,
  };
  if (previousId) payload.previous_response_id = previousId;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`Assistant provider returned HTTP ${response.status}`);
  const result = await response.json();
  const reply = (result.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!reply || !result.id) throw new Error("Assistant provider returned no text response");
  await redisCommand("SET", `belic:wa:conversation:${sender}`, result.id, "EX", "2592000");
  return reply.slice(0, 3800);
}

async function sendWhatsAppMessage(recipient, text) {
  const version = process.env.WHATSAPP_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version || "")) throw new Error("WHATSAPP_GRAPH_API_VERSION must look like vNN.N");
  const response = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { preview_url: false, body: text },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`WhatsApp Cloud API returned HTTP ${response.status}`);
}

async function handleMessages(value) {
  const messages = value?.messages || [];
  for (const message of messages) {
    if (!message.id || !message.from) continue;
    const text = message.type === "text" ? message.text?.body?.trim() : "";
    const claim = await redisCommand("SET", `belic:wa:seen:${message.id}`, "processing", "NX", "EX", "86400");
    if (claim !== "OK") continue;
    try {
      const reply = text
        ? await createReply(message.from, text)
        : "Thanks for reaching Belic. Please send your question as a text message and I’ll help you from there.";
      await sendWhatsAppMessage(message.from, reply);
      await redisCommand("SET", `belic:wa:seen:${message.id}`, "sent", "EX", "86400");
    } catch (error) {
      await redisCommand("DEL", `belic:wa:seen:${message.id}`).catch(() => {});
      throw error;
    }
  }
}

module.exports = async function whatsappWebhook(req, res) {
  if (req.method === "GET") {
    const query = req.query || {};
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "";
    if (!verifyToken) return sendJson(res, 503, { error: "Webhook verification is not configured" });
    if (query["hub.mode"] === "subscribe" && safeEqual(query["hub.verify_token"] || "", verifyToken)) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end(String(query["hub.challenge"] || ""));
    }
    return sendJson(res, 403, { error: "Webhook verification failed" });
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    requireEnv([
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_GRAPH_API_VERSION",
      "OPENAI_API_KEY",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]);
    const rawBody = await readRawBody(req);
    const suppliedSignature = req.headers["x-hub-signature-256"] || "";
    const expectedSignature = `sha256=${createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex")}`;
    if (!safeEqual(suppliedSignature, expectedSignature)) return sendJson(res, 401, { error: "Invalid webhook signature" });

    const body = JSON.parse(rawBody.toString("utf8"));
    if (body.object !== "whatsapp_business_account") return sendJson(res, 404, { error: "Unsupported webhook object" });
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "messages") await handleMessages(change.value);
      }
    }
    res.statusCode = 200;
    return res.end("EVENT_RECEIVED");
  } catch (error) {
    console.error("WhatsApp webhook error:", error.message);
    return sendJson(res, 500, { error: "Webhook processing failed" });
  }
};

module.exports.config = { api: { bodyParser: false } };

