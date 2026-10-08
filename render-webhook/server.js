import crypto from "node:crypto";
import http from "node:http";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_TOKEN = String(process.env.OPENWA_WEBHOOK_TOKEN || "").trim();
const DEFAULT_CLIENT_ID = String(process.env.SA_CONNECT_CLIENT_ID || "").trim();
const DEFAULT_SESSION_ID = String(process.env.OPENWA_SESSION_ID || "sa-connect").trim();

function initFirebase() {
  if (getApps().length) return getApps()[0];

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");

  const credentials = JSON.parse(raw);
  return initializeApp({ credential: cert(credentials) });
}

function db() {
  initFirebase();
  return getFirestore();
}

function normalizePhone(value = "") {
  return String(value).replace(/\\D/g, "");
}

function conversationId(clientId, phone) {
  return `${clientId}_${normalizePhone(phone)}`;
}

function messageText(data = {}) {
  if (typeof data.body === "string" && data.body.trim()) return data.body;
  if (typeof data.text === "string" && data.text.trim()) return data.text;
  if (data.caption) return String(data.caption);
  const type = String(data.type || "unknown");
  if (["image", "video", "document"].includes(type)) return `[${type}]`;
  if (type === "audio") return "[Audio]";
  if (type === "sticker") return "[Sticker]";
  if (type === "location") return "[Location]";
  if (type === "contact" || type === "contacts") return "[Contact]";
  return type === "text" ? "[Message]" : `[${type}]`;
}

function safeDocId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 40);
}

function verifyToken(req) {
  if (!WEBHOOK_TOKEN) return true;
  const supplied = String(req.headers["x-webhook-token"] || "").trim();
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(WEBHOOK_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function resolveClientId(payload) {
  if (DEFAULT_CLIENT_ID) return DEFAULT_CLIENT_ID;

  const sessionId = String(payload.sessionId || DEFAULT_SESSION_ID).trim();
  const snap = await db().collection("openwaSessions").doc(sessionId).get();
  if (snap.exists && snap.data()?.clientId) return String(snap.data().clientId);

  throw new Error("SA_CONNECT_CLIENT_ID is not configured for this OpenWA session.");
}

async function processIncoming(payload) {
  if (payload?.event !== "message.received") return { ignored: true };

  const data = payload.data || {};
  const phone = normalizePhone(data.author || data.from || "");
  if (!phone) return { ignored: true, reason: "missing_sender" };

  const clientId = await resolveClientId(payload);
  const text = messageText(data);
  const cid = conversationId(clientId, phone);
  const messageId = String(data.id || payload.idempotencyKey || payload.deliveryId || `${cid}_${Date.now()}`);
  const messageDocId = safeDocId(messageId);
  const firestore = db();

  const messageRef = firestore.collection("whatsappMessages").doc(messageDocId);
  const existing = await messageRef.get();
  if (existing.exists) return { ok: true, duplicate: true };

  const contactName = String(data.pushname || data.notifyName || data.name || phone);
  const now = FieldValue.serverTimestamp();

  await messageRef.set({
    clientId,
    conversationId: cid,
    phone,
    text,
    body: text,
    type: String(data.type || "text"),
    direction: "inbound",
    fromCustomer: true,
    fromMe: false,
    status: "received",
    messageId,
    timestamp: now,
    createdAt: now,
    source: "whatsapp_openwa",
    channel: "whatsapp_web_bridge",
    openwaSessionId: String(payload.sessionId || DEFAULT_SESSION_ID),
    openwaDeliveryId: String(payload.deliveryId || "")
  });

  await firestore.collection("whatsappConversations").doc(cid).set({
    clientId,
    phone,
    contactName,
    lastMessage: text,
    lastMessageAt: now,
    unreadCount: FieldValue.increment(1),
    source: "whatsapp_openwa",
    channel: "whatsapp_web_bridge",
    updatedAt: now
  }, { merge: true });

  const leads = await firestore.collection("leads")
    .where("clientId", "==", clientId)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  let leadId = "";
  if (!leads.empty) {
    leadId = leads.docs[0].id;
    await leads.docs[0].ref.set({
      name: contactName || leads.docs[0].data()?.name || phone,
      phone,
      source: "whatsapp_openwa",
      channel: "whatsapp_web_bridge",
      requirement: text || leads.docs[0].data()?.requirement || "",
      message: text || leads.docs[0].data()?.message || "",
      updatedAt: now
    }, { merge: true });
  } else {
    const lead = await firestore.collection("leads").add({
      clientId,
      name: contactName || phone,
      phone,
      email: "",
      state: "",
      city: "",
      requirement: text,
      message: text,
      source: "whatsapp_openwa",
      channel: "whatsapp_web_bridge",
      status: "new",
      notes: "",
      tag: "",
      priority: "normal",
      budget: "",
      leadType: "whatsapp",
      createdAt: now,
      updatedAt: now
    });
    leadId = lead.id;
  }

  await firestore.collection("leadTimeline").add({
    clientId,
    leadId,
    type: "whatsapp_incoming",
    title: "WhatsApp message received",
    description: text || "Incoming WhatsApp message",
    createdBy: "openwa_webhook",
    createdByName: contactName,
    createdAt: now
  });

  return { ok: true, clientId, conversationId: cid, messageId };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "sa-connect-openwa-webhook" }));
      return;
    }

    if (req.method === "POST" && req.url === "/webhook/openwa") {
      if (!verifyToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook token." }));
        return;
      }

      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const result = await processIncoming(payload);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  } catch (error) {
    console.error("OpenWA webhook error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Webhook processing failed." }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`S&A Connect OpenWA webhook listening on 0.0.0.0:${PORT}`);
  console.log(`OpenWA session: ${DEFAULT_SESSION_ID}`);
  console.log(`Client configured: ${DEFAULT_CLIENT_ID ? "yes" : "no"}`);
});
