import crypto from "node:crypto";
import http from "node:http";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_SECRET = String(process.env.OPENWA_WEBHOOK_SECRET || "").trim();
const DEFAULT_CLIENT_ID = String(process.env.SA_CONNECT_CLIENT_ID || "").trim();
const DEFAULT_SESSION_ID = String(process.env.OPENWA_SESSION_ID || "sa-connect").trim();
const OPENWA_BASE_URL = String(process.env.OPENWA_BASE_URL || "").replace(/\/$/, "");
const OPENWA_API_KEY = String(process.env.OPENWA_API_KEY || "").trim();
const SUPER_ADMIN_EMAILS = String(process.env.SA_CONNECT_SUPER_ADMIN_EMAILS || "")
  .split(",").map(v => v.trim().toLowerCase()).filter(Boolean);

function initFirebase() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}
function db() { initFirebase(); return getFirestore(); }
function auth() { initFirebase(); return getAuth(); }
function normalizePhone(value = "") { return String(value).replace(/\D/g, ""); }
function conversationId(clientId, phone) { return `${clientId}_${normalizePhone(phone)}`; }

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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

function verifyOpenWASignature(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
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
  const firestore = db();
  const messageRef = firestore.collection("whatsappMessages").doc(safeDocId(messageId));

  if ((await messageRef.get()).exists) return { ok: true, duplicate: true };

  const contactName = String(data.pushname || data.notifyName || data.name || phone);
  const now = FieldValue.serverTimestamp();

  await messageRef.set({
    clientId, conversationId: cid, phone, text, body: text,
    type: String(data.type || "text"), direction: "inbound",
    fromCustomer: true, fromMe: false, status: "received", messageId,
    timestamp: now, createdAt: now, source: "whatsapp_openwa",
    channel: "whatsapp_web_bridge",
    openwaSessionId: String(payload.sessionId || DEFAULT_SESSION_ID),
    openwaDeliveryId: String(payload.deliveryId || "")
  });

  await firestore.collection("whatsappConversations").doc(cid).set({
    clientId, phone, contactName, lastMessage: text,
    lastMessageAt: now, unreadCount: FieldValue.increment(1),
    source: "whatsapp_openwa", channel: "whatsapp_web_bridge", updatedAt: now
  }, { merge: true });

  const leads = await firestore.collection("leads")
    .where("clientId", "==", clientId).where("phone", "==", phone).limit(1).get();

  let leadId = "";
  if (!leads.empty) {
    leadId = leads.docs[0].id;
    await leads.docs[0].ref.set({
      name: contactName || leads.docs[0].data()?.name || phone,
      phone, source: "whatsapp_openwa", channel: "whatsapp_web_bridge",
      requirement: text || leads.docs[0].data()?.requirement || "",
      message: text || leads.docs[0].data()?.message || "", updatedAt: now
    }, { merge: true });
  } else {
    const lead = await firestore.collection("leads").add({
      clientId, name: contactName || phone, phone, email: "", state: "", city: "",
      requirement: text, message: text, source: "whatsapp_openwa",
      channel: "whatsapp_web_bridge", status: "new", notes: "", tag: "",
      priority: "normal", budget: "", leadType: "whatsapp",
      createdAt: now, updatedAt: now
    });
    leadId = lead.id;
  }

  await firestore.collection("leadTimeline").add({
    clientId, leadId, type: "whatsapp_incoming",
    title: "WhatsApp message received",
    description: text || "Incoming WhatsApp message",
    createdBy: "openwa_webhook", createdByName: contactName,
    createdAt: now
  });

  return { ok: true, clientId, conversationId: cid, messageId };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  return { raw, body: JSON.parse(raw.toString("utf8") || "{}") };
}

async function verifySuperAdmin(req) {
  if (!SUPER_ADMIN_EMAILS.length) throw new Error("SA_CONNECT_SUPER_ADMIN_EMAILS is not configured.");
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) throw new Error("Missing Firebase ID token.");
  const token = header.slice(7).trim();
  const decoded = await auth().verifyIdToken(token);
  const email = String(decoded.email || "").toLowerCase();
  if (!email || !SUPER_ADMIN_EMAILS.includes(email)) throw new Error("Super-admin access denied.");
  return decoded;
}

async function createClient(body) {
  const businessName = String(body.businessName || "").trim();
  const ownerName = String(body.ownerName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = normalizePhone(body.phone || "");
  const password = String(body.password || "");

  if (!businessName || !ownerName || !email || password.length < 6) {
    throw new Error("Business name, owner name, email and a 6+ character password are required.");
  }

  const clientId = `${businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "client"}-${crypto.randomBytes(4).toString("hex")}`;
  const user = await auth().createUser({ email, password, displayName: ownerName });
  const now = FieldValue.serverTimestamp();

  await db().collection("clients").doc(clientId).set({
    clientId, businessName, ownerName, email, phone,
    status: "active", createdAt: now, updatedAt: now
  });

  await db().collection("users").doc(user.uid).set({
    clientId, name: ownerName, email, phone, role: "admin",
    platformRole: "client_admin", status: "active",
    createdAt: now, updatedAt: now
  });

  return { clientId, uid: user.uid, businessName, ownerName, email, phone };
}

async function sendOpenWAText(sessionId, chatId, text) {
  if (!OPENWA_BASE_URL || !OPENWA_API_KEY) throw new Error("OPENWA_BASE_URL and OPENWA_API_KEY are required.");
  const response = await fetch(`${OPENWA_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": OPENWA_API_KEY },
    body: JSON.stringify({ chatId, text })
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`OpenWA send failed (${response.status}): ${responseText}`);
  return JSON.parse(responseText || "{}");
}

async function processOutgoing(body) {
  const clientId = String(body.clientId || "").trim();
  const phone = normalizePhone(body.phone || "");
  const text = String(body.message || body.text || "").trim();
  const sessionId = String(body.sessionId || DEFAULT_SESSION_ID).trim();
  if (!clientId || !phone || !text) throw new Error("clientId, phone and message are required.");

  const chatId = phone.includes("@") ? phone : `${phone}@c.us`;
  const result = await sendOpenWAText(sessionId, chatId, text);
  const firestore = db();
  const cid = conversationId(clientId, phone);
  const now = FieldValue.serverTimestamp();
  const messageId = String(result?.id || result?.message?.id || `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);

  await firestore.collection("whatsappMessages").doc(safeDocId(messageId)).set({
    clientId, conversationId: cid, phone, text, body: text, type: "text",
    direction: "outbound", fromCustomer: false, fromMe: true, status: "sent",
    messageId, timestamp: now, createdAt: now,
    source: "whatsapp_openwa", channel: "whatsapp_web_bridge",
    openwaSessionId: sessionId
  });

  await firestore.collection("whatsappConversations").doc(cid).set({
    clientId, phone, lastMessage: text, lastMessageAt: now,
    source: "whatsapp_openwa", channel: "whatsapp_web_bridge", updatedAt: now
  }, { merge: true });

  return { ok: true, clientId, conversationId: cid, messageId, openwa: result };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true, service: "sa-connect-openwa-webhook" });
      return;
    }

    if (req.method === "POST" && req.url === "/webhook/openwa") {
      const raw = await readBody(req);
      if (!verifyOpenWASignature(raw, req.headers["x-openwa-signature"])) {
        json(res, 401, { error: "Invalid OpenWA signature." });
        return;
      }
      const payload = JSON.parse(raw.toString("utf8") || "{}");
      json(res, 200, await processIncoming(payload));
      return;
    }

    if (req.method === "POST" && req.url === "/api/admin/clients") {
      await verifySuperAdmin(req);
      const { body } = await readJson(req);
      json(res, 201, await createClient(body));
      return;
    }

    if (req.method === "POST" && req.url === "/api/whatsapp/send") {
      const { body } = await readJson(req);
      json(res, 200, await processOutgoing(body));
      return;
    }

    json(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("S&A Connect API error:", error);
    const status = /access denied|missing firebase id token|super-admin|signature/i.test(String(error.message)) ? 403 : 500;
    json(res, status, { error: error.message || "Request failed." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`S&A Connect OpenWA service listening on 0.0.0.0:${PORT}`);
  console.log(`OpenWA session: ${DEFAULT_SESSION_ID}`);
  console.log(`Default client configured: ${DEFAULT_CLIENT_ID ? "yes" : "no"}`);
});
