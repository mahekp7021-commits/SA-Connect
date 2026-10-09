import crypto from "node:crypto";
import http from "node:http";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_SECRET = String(process.env.OPENWA_WEBHOOK_SECRET || "").trim();
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

const ALLOWED_ORIGINS = new Set([
  "https://sa-connect-844ce.web.app",
  "https://sa-connect-844ce.firebaseapp.com"
]);

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenWA-Signature");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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
  const sessionId = String(payload.sessionId || payload.data?.sessionId || DEFAULT_SESSION_ID).trim();
  const snap = await db().collection("openwaSessions").doc(sessionId).get();
  if (snap.exists && snap.data()?.clientId) return String(snap.data().clientId);
  // Never route an unmapped session to another tenant. Map every session explicitly.
  throw new Error("No client is mapped to OpenWA session " + sessionId + ".");
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


// ----- Separate Meta Cloud API and tenant-scoped OpenWA QR integrations -----
async function verifyClientUser(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) throw new Error("Missing Firebase ID token.");
  const decoded = await auth().verifyIdToken(header.slice(7).trim());
  const profile = await db().collection("users").doc(decoded.uid).get();
  if (!profile.exists || !profile.data()?.clientId) throw new Error("No client workspace is linked to this user.");
  return { decoded, profile: profile.data(), clientId: String(profile.data().clientId) };
}
function metaEncryptionKey() {
  const value = String(process.env.META_CREDENTIAL_ENCRYPTION_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("META_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters.");
  return Buffer.from(value, "hex");
}
function encryptMetaToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", metaEncryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), data: data.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}
function decryptMetaToken(value) {
  if (!value?.iv || !value?.data || !value?.tag) throw new Error("Meta access token is not configured.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", metaEncryptionKey(), Buffer.from(value.iv, "hex"));
  decipher.setAuthTag(Buffer.from(value.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "hex")), decipher.final()]).toString("utf8");
}
async function openwaRequest(path, options = {}) {
  if (!OPENWA_BASE_URL || !OPENWA_API_KEY) throw new Error("OpenWA service URL/API key is not configured on the server.");
  const response = await fetch(OPENWA_BASE_URL + path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-API-Key": OPENWA_API_KEY, ...(options.headers || {}) }
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch { data = { raw }; }
  if (!response.ok) throw new Error("OpenWA request failed (" + response.status + "): " + raw.slice(0, 300));
  return data;
}
async function getClientOpenWASession(clientId) {
  const snap = await db().collection("openwaSessions").where("clientId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  return { sessionId: snap.docs[0].id, ...snap.docs[0].data() };
}
async function createClientOpenWASession(clientId, uid) {
  const existing = await getClientOpenWASession(clientId);
  if (existing) return existing;
  if (!WEBHOOK_SECRET) throw new Error("OPENWA_WEBHOOK_SECRET is not configured.");
  const publicBase = String(process.env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
  if (!publicBase) throw new Error("PUBLIC_API_BASE_URL must be set to this Render webhook service URL.");
  const safeClient = clientId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "client";
  const sessionId = "sanc-" + safeClient + "-" + crypto.randomBytes(3).toString("hex");
  await openwaRequest("/api/sessions", { method: "POST", body: JSON.stringify({ id: sessionId, name: "S&A Connect " + clientId }) });
  const webhook = await openwaRequest("/api/sessions/" + encodeURIComponent(sessionId) + "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      url: publicBase + "/webhook/openwa",
      events: ["message.received", "message.ack", "session.disconnected"],
      secret: WEBHOOK_SECRET
    })
  });
  await db().collection("openwaSessions").doc(sessionId).set({
    clientId, sessionId, status: "connecting", webhookId: String(webhook.id || ""),
    createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  return { sessionId, clientId, status: "connecting", webhookId: String(webhook.id || "") };
}
async function processMetaWebhook(payload) {
  const firestore = db();
  let processed = 0;
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== "messages") continue;
      const value = change.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || "");
      if (!phoneNumberId) continue;
      const config = await firestore.collection("metaWhatsAppPhoneNumbers").doc(phoneNumberId).get();
      if (!config.exists || !config.data()?.clientId) continue;
      const clientId = String(config.data().clientId);
      const contacts = new Map((value.contacts || []).map(c => [String(c.wa_id || ""), c]));
      for (const message of value.messages || []) {
        const phone = normalizePhone(message.from || "");
        if (!phone) continue;
        const contactName = String(contacts.get(phone)?.profile?.name || phone);
        const text = message.type === "text" ? String(message.text?.body || "") :
          message.type === "image" ? String(message.image?.caption || "[Image]") :
          message.type === "video" ? String(message.video?.caption || "[Video]") :
          message.type === "document" ? String(message.document?.caption || "[Document]") :
          message.type === "audio" ? "[Audio]" : "[" + String(message.type || "message") + "]";
        const cid = conversationId(clientId, phone);
        const wamid = String(message.id || (cid + "_" + Date.now()));
        const msgRef = firestore.collection("whatsappMessages").doc(safeDocId("meta:" + wamid));
        if ((await msgRef.get()).exists) continue;
        const now = FieldValue.serverTimestamp();
        await msgRef.set({
          clientId, conversationId: cid, phone, text, body: text, type: String(message.type || "text"),
          direction: "inbound", fromCustomer: true, fromMe: false, status: "received",
          messageId: wamid, timestamp: now, createdAt: now, source: "whatsapp_meta",
          channel: "whatsapp_business_platform", metaPhoneNumberId: phoneNumberId, metaWabaId: String(entry.id || "")
        });
        await firestore.collection("whatsappConversations").doc(cid).set({
          clientId, phone, contactName, lastMessage: text, lastMessageAt: now,
          unreadCount: FieldValue.increment(1), source: "whatsapp_meta",
          channel: "whatsapp_business_platform", updatedAt: now
        }, { merge: true });
        const leads = await firestore.collection("leads").where("clientId", "==", clientId).where("phone", "==", phone).limit(1).get();
        let leadId = "";
        if (!leads.empty) {
          leadId = leads.docs[0].id;
          await leads.docs[0].ref.set({ name: contactName, phone, source: "whatsapp_meta", channel: "whatsapp_business_platform", requirement: text, message: text, updatedAt: now }, { merge: true });
        } else {
          const lead = await firestore.collection("leads").add({
            clientId, name: contactName, phone, email: "", state: "", city: "", requirement: text, message: text,
            source: "whatsapp_meta", channel: "whatsapp_business_platform", status: "new", notes: "", tag: "",
            priority: "normal", budget: "", leadType: "whatsapp", createdAt: now, updatedAt: now
          });
          leadId = lead.id;
        }
        await firestore.collection("leadTimeline").add({
          clientId, leadId, type: "whatsapp_meta_incoming", title: "Official WhatsApp message received",
          description: text, createdBy: "meta_webhook", createdByName: contactName, createdAt: now
        });
        processed++;
      }
      for (const status of value.statuses || []) {
        const wamid = String(status.id || "");
        if (!wamid) continue;
        const snap = await firestore.collection("whatsappMessages").where("messageId", "==", wamid).where("channel", "==", "whatsapp_business_platform").limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.set({ status: String(status.status || "unknown"), statusUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }
  }
  return { ok: true, processed };
}
async function sendMetaText(clientId, phone, text) {
  const snap = await db().collection("metaWhatsAppClientConfigs").doc(clientId).get();
  if (!snap.exists) throw new Error("Official Meta WhatsApp API is not configured for this client.");
  const config = snap.data();
  const phoneNumberId = String(config.phoneNumberId || "");
  const accessToken = decryptMetaToken(config.accessTokenEncrypted);
  const response = await fetch("https://graph.facebook.com/" + String(process.env.META_GRAPH_API_VERSION || "v23.0") + "/" + encodeURIComponent(phoneNumberId) + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: normalizePhone(phone), type: "text", text: { preview_url: false, body: text } })
  });
  const raw = await response.text();
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch { data = { raw }; }
  if (!response.ok) throw new Error("Meta WhatsApp API failed (" + response.status + "): " + (data.error?.message || raw.slice(0, 300)));
  const wamid = String(data.messages?.[0]?.id || ("meta_out_" + Date.now()));
  const cid = conversationId(clientId, phone);
  const now = FieldValue.serverTimestamp();
  await db().collection("whatsappMessages").doc(safeDocId("meta:" + wamid)).set({
    clientId, conversationId: cid, phone: normalizePhone(phone), text, body: text, type: "text",
    direction: "outbound", fromCustomer: false, fromMe: true, status: "sent", messageId: wamid,
    timestamp: now, createdAt: now, source: "whatsapp_meta", channel: "whatsapp_business_platform",
    metaPhoneNumberId: phoneNumberId
  });
  await db().collection("whatsappConversations").doc(cid).set({
    clientId, phone: normalizePhone(phone), lastMessage: text, lastMessageAt: now,
    source: "whatsapp_meta", channel: "whatsapp_business_platform", updatedAt: now
  }, { merge: true });
  return { ok: true, messageId: wamid, status: "sent" };
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {

    if (req.method === "GET" && req.url.startsWith("/webhook/meta")) {
      const url = new URL(req.url, "http://localhost");
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === String(process.env.META_WEBHOOK_VERIFY_TOKEN || "")) {
        res.writeHead(200, { "Content-Type": "text/plain" }); res.end(challenge || ""); return;
      }
      json(res, 403, { error: "Meta webhook verification failed." }); return;
    }
    if (req.method === "POST" && req.url === "/webhook/meta") {
      const raw = await readBody(req);
      const secret = String(process.env.META_APP_SECRET || "");
      const signature = String(req.headers["x-hub-signature-256"] || "");
      if (!secret || !signature.startsWith("sha256=")) { json(res, 401, { error: "Meta webhook signature is missing." }); return; }
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
      const a = Buffer.from(signature), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { json(res, 401, { error: "Invalid Meta webhook signature." }); return; }
      json(res, 200, await processMetaWebhook(JSON.parse(raw.toString("utf8") || "{}"))); return;
    }
    if (req.method === "GET" && req.url === "/api/whatsapp/meta/config") {
      const user = await verifyClientUser(req);
      const snap = await db().collection("metaWhatsAppClientConfigs").doc(user.clientId).get();
      const data = snap.exists ? snap.data() : {};
      json(res, 200, { configured: !!data?.phoneNumberId, phoneNumberId: data?.phoneNumberId || "", wabaId: data?.wabaId || "", displayPhoneNumber: data?.displayPhoneNumber || "", channel: "whatsapp_business_platform" }); return;
    }
    if (req.method === "POST" && req.url === "/api/whatsapp/meta/config") {
      const user = await verifyClientUser(req);
      if (!["admin", "owner"].includes(String(user.profile.role || "").toLowerCase())) { json(res, 403, { error: "Only a client admin can configure WhatsApp." }); return; }
      const { body } = await readJson(req);
      const phoneNumberId = String(body.phoneNumberId || "").trim();
      const wabaId = String(body.wabaId || "").trim();
      const accessToken = String(body.accessToken || "").trim();
      const displayPhoneNumber = String(body.displayPhoneNumber || "").trim();
      if (!phoneNumberId || !accessToken) throw new Error("Phone Number ID and access token are required.");
      const oldConfig = await db().collection("metaWhatsAppClientConfigs").doc(user.clientId).get();
      const existingPhoneMap = await db().collection("metaWhatsAppPhoneNumbers").doc(phoneNumberId).get();
      if (existingPhoneMap.exists && existingPhoneMap.data()?.clientId !== user.clientId) {
        throw new Error("This Meta Phone Number ID is already linked to another S&A Connect client.");
      }
      const encrypted = encryptMetaToken(accessToken);
      const configData = { clientId: user.clientId, phoneNumberId, wabaId, displayPhoneNumber, accessTokenEncrypted: encrypted, configuredBy: user.decoded.uid, updatedAt: FieldValue.serverTimestamp(), provider: "meta_cloud_api" };
      if (!oldConfig.exists) configData.createdAt = FieldValue.serverTimestamp();
      await db().collection("metaWhatsAppClientConfigs").doc(user.clientId).set(configData, { merge: true });
      const previousPhoneId = String(oldConfig.data()?.phoneNumberId || "");
      if (previousPhoneId && previousPhoneId !== phoneNumberId) {
        const previousMap = db().collection("metaWhatsAppPhoneNumbers").doc(previousPhoneId);
        const previousSnap = await previousMap.get();
        if (previousSnap.exists && previousSnap.data()?.clientId === user.clientId) await previousMap.delete();
      }
      await db().collection("metaWhatsAppPhoneNumbers").doc(phoneNumberId).set({ clientId: user.clientId, phoneNumberId, wabaId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      json(res, 200, { ok: true, configured: true, phoneNumberId, wabaId, displayPhoneNumber }); return;
    }
    if (req.method === "POST" && req.url === "/api/whatsapp/meta/disconnect") {
      const user = await verifyClientUser(req);
      if (!["admin", "owner"].includes(String(user.profile.role || "").toLowerCase())) { json(res, 403, { error: "Only a client admin can disconnect WhatsApp." }); return; }
      const ref = db().collection("metaWhatsAppClientConfigs").doc(user.clientId);
      const snap = await ref.get();
      if (snap.exists) {
        const phoneNumberId = String(snap.data()?.phoneNumberId || "");
        await ref.delete();
        if (phoneNumberId) {
          const mapping = db().collection("metaWhatsAppPhoneNumbers").doc(phoneNumberId);
          const mapped = await mapping.get();
          if (mapped.exists && mapped.data()?.clientId === user.clientId) await mapping.delete();
        }
      }
      json(res, 200, { ok: true, message: "Official Meta WhatsApp API credentials removed for this client." }); return;
    }
    if (req.method === "POST" && req.url === "/api/whatsapp/meta/send") {
      const user = await verifyClientUser(req);
      const { body } = await readJson(req);
      const phone = normalizePhone(body.phone || "");
      const message = String(body.message || body.text || "").trim();
      if (!phone || !message) throw new Error("phone and message are required.");
      json(res, 200, await sendMetaText(user.clientId, phone, message)); return;
    }
    if (req.method === "POST" && req.url === "/api/whatsapp/openwa/connect") {
      const user = await verifyClientUser(req);
      if (!["admin", "owner"].includes(String(user.profile.role || "").toLowerCase())) { json(res, 403, { error: "Only a client admin can connect WhatsApp QR." }); return; }
      json(res, 200, await createClientOpenWASession(user.clientId, user.decoded.uid)); return;
    }
    if (req.method === "GET" && req.url === "/api/whatsapp/openwa/status") {
      const user = await verifyClientUser(req);
      const session = await getClientOpenWASession(user.clientId);
      if (!session) { json(res, 200, { connected: false, configured: false, status: "not_connected" }); return; }
      const remote = await openwaRequest("/api/sessions/" + encodeURIComponent(session.sessionId));
      const status = String(remote.status || remote.state || remote.session?.status || session.status || "unknown");
      await db().collection("openwaSessions").doc(session.sessionId).set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      json(res, 200, { configured: true, connected: ["open", "connected", "ready"].includes(status.toLowerCase()), status, sessionId: session.sessionId }); return;
    }
    if (req.method === "GET" && req.url === "/api/whatsapp/openwa/qr") {
      const user = await verifyClientUser(req);
      const session = await getClientOpenWASession(user.clientId);
      if (!session) { json(res, 404, { error: "Connect WhatsApp first to create a session." }); return; }
      json(res, 200, { sessionId: session.sessionId, ...(await openwaRequest("/api/sessions/" + encodeURIComponent(session.sessionId) + "/qr")) }); return;
    }
    if (req.method === "POST" && req.url === "/api/whatsapp/openwa/send") {
      const user = await verifyClientUser(req);
      const { body } = await readJson(req);
      const phone = normalizePhone(body.phone || "");
      const message = String(body.message || body.text || "").trim();
      if (!phone || !message) throw new Error("phone and message are required.");
      const session = await getClientOpenWASession(user.clientId);
      if (!session) throw new Error("Connect the client's OpenWA QR session first.");
      json(res, 200, await processOutgoing({ clientId: user.clientId, phone, message, sessionId: session.sessionId })); return;
    }

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

    if (req.method === "GET" && req.url === "/api/admin/clients") {
      await verifySuperAdmin(req);
      const snap = await db().collection("clients").orderBy("createdAt", "desc").limit(100).get();
      const clients = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      json(res, 200, { clients });
      return;
    }

    if (req.method === "POST" && req.url === "/api/admin/clients") {
      await verifySuperAdmin(req);
      const { body } = await readJson(req);
      json(res, 201, await createClient(body));
      return;
    }

    if (req.method === "POST" && req.url === "/api/whatsapp/send") {
      const user = await verifyClientUser(req);
      const { body } = await readJson(req);
      const phone = normalizePhone(body.phone || body.to || "");
      const message = String(body.message || body.text || "").trim();
      if (!phone || !message) throw new Error("phone and message are required.");
      const session = await getClientOpenWASession(user.clientId);
      if (!session) throw new Error("Connect the client's OpenWA QR session first.");
      json(res, 200, await processOutgoing({ clientId: user.clientId, phone, message, sessionId: session.sessionId }));
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
});
