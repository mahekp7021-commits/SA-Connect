import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import Pino from "pino";
import QRCode from "qrcode";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 10000);
const SERVICE_KEY = process.env.QR_SERVICE_KEY || "";
const SESSION_ROOT = process.env.SESSION_ROOT || path.join(__dirname, "sessions");
const LOG_LEVEL = process.env.LOG_LEVEL || "silent";

fs.mkdirSync(SESSION_ROOT, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
const sessions = new Map();

function safeClientId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid clientId.");
  return id;
}

function auth(req) {
  if (!SERVICE_KEY) throw new Error("QR_SERVICE_KEY is not configured.");
  const supplied = String(req.header("x-qr-service-key") || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(SERVICE_KEY);
  if (!supplied || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const error = new Error("Unauthorized.");
    error.status = 401;
    throw error;
  }
}

function getClientId(req) {
  return safeClientId(req.header("x-client-id") || req.query.clientId);
}

function sessionFolder(clientId) {
  return path.join(SESSION_ROOT, clientId);
}

function publicStatus(session) {
  return {
    clientId: session.clientId,
    status: session.status,
    qr: session.qrDataUrl || null,
    phone: session.phone || null,
    name: session.name || null,
    lastError: session.lastError || null,
    updatedAt: session.updatedAt
  };
}

function updateSession(session, patch) {
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
}

function firebaseApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

function db() {
  const appInstance = firebaseApp();
  return appInstance ? getFirestore(appInstance) : null;
}

async function saveQrStatus(session) {
  const firestore = db();
  if (!firestore) return;
  await firestore.collection("whatsappQrConnections").doc(session.clientId).set({
    clientId: session.clientId,
    status: session.status,
    phone: session.phone || "",
    name: session.name || "",
    hasQr: Boolean(session.qrDataUrl),
    lastError: session.lastError || "",
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

function phoneFromJid(jid) {
  return String(jid || "").split("@")[0].replace(/\D/g, "");
}

async function saveIncomingMessage(session, message) {
  const firestore = db();
  if (!firestore) return;

  const jid = message.key?.remoteJid || "";
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

  const phone = phoneFromJid(jid);
  if (!phone) return;

  const messageId = message.key?.id || crypto.randomUUID();
  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption ||
    message.message?.documentMessage?.caption ||
    "";

  await firestore.collection("whatsappMessages").doc(messageId).set({
    id: messageId,
    clientId: session.clientId,
    source: "whatsapp_qr",
    channel: "whatsapp_qr",
    direction: "inbound",
    phone,
    message: text,
    messageType: message.message ? Object.keys(message.message)[0] || "unknown" : "unknown",
    timestamp: FieldValue.serverTimestamp(),
    whatsappMessageId: messageId
  }, { merge: true });

  await firestore.collection("whatsappConversations").doc(session.clientId + "_" + phone).set({
    id: session.clientId + "_" + phone,
    clientId: session.clientId,
    source: "whatsapp_qr",
    channel: "whatsapp_qr",
    phone,
    lastMessage: text,
    lastMessageAt: FieldValue.serverTimestamp(),
    unread: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function startSession(clientId) {
  const existing = sessions.get(clientId);

  if (existing?.sock && ["connecting", "connected"].includes(existing.status)) return existing;
  if (existing?.starting) return existing;

  const session = existing || {
    clientId,
    status: "starting",
    qrDataUrl: null,
    phone: "",
    name: "",
    lastError: "",
    updatedAt: new Date().toISOString(),
    sock: null,
    starting: false
  };

  sessions.set(clientId, session);
  session.starting = true;

  const folder = sessionFolder(clientId);
  fs.mkdirSync(folder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(folder);

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: LOG_LEVEL }),
    browser: ["S&A Connect", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  session.sock = sock;
  updateSession(session, {
    status: state.creds.registered ? "connecting" : "waiting_for_qr",
    qrDataUrl: null,
    lastError: ""
  });
  await saveQrStatus(session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qrDataUrl = await QRCode.toDataURL(qr, {
          width: 360,
          margin: 2,
          errorCorrectionLevel: "M"
        });
        updateSession(session, { status: "waiting_for_scan" });
        await saveQrStatus(session);
      }

      if (connection === "open") {
        const me = sock.user;
        const phone = String(me?.id || "").split(":")[0].split("@")[0];
        updateSession(session, {
          status: "connected",
          qrDataUrl: null,
          phone,
          name: me?.name || ""
        });
        await saveQrStatus(session);
      }

      if (connection === "close") {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        updateSession(session, {
          status: loggedOut ? "logged_out" : "disconnected",
          qrDataUrl: null,
          lastError: loggedOut ? "WhatsApp session logged out." : "Connection closed."
        });
        session.sock = null;
        session.starting = false;
        await saveQrStatus(session);

        if (!loggedOut) {
          setTimeout(() => {
            startSession(clientId).catch(async (error) => {
              updateSession(session, { status: "error", lastError: error.message });
              session.starting = false;
              await saveQrStatus(session).catch(() => {});
            });
          }, 1500);
        }
      }
    } catch (error) {
      updateSession(session, { status: "error", lastError: error.message || "Connection update failed." });
      session.starting = false;
      await saveQrStatus(session).catch(() => {});
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      if (message.key?.fromMe) continue;
      await saveIncomingMessage(session, message).catch((error) => {
        console.error("Incoming message save failed:", error);
      });
    }
  });

  session.starting = false;
  return session;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sa-connect-qr-service",
    sessions: sessions.size,
    time: new Date().toISOString()
  });
});

app.post("/api/qr/start", async (req, res) => {
  try {
    auth(req);
    const clientId = getClientId(req);
    const session = await startSession(clientId);
    res.json({ ok: true, ...publicStatus(session) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Unable to start QR session." });
  }
});

app.get("/api/qr/status", async (req, res) => {
  try {
    auth(req);
    const clientId = getClientId(req);
    const session = sessions.get(clientId);

    if (!session) {
      res.json({
        ok: true,
        clientId,
        status: "not_started",
        qr: null,
        phone: null,
        name: null,
        lastError: null
      });
      return;
    }

    res.json({ ok: true, ...publicStatus(session) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Unable to read QR status." });
  }
});

app.post("/api/qr/logout", async (req, res) => {
  try {
    auth(req);
    const clientId = getClientId(req);
    const session = sessions.get(clientId);

    if (session?.sock) await session.sock.logout().catch(() => {});

    fs.rmSync(sessionFolder(clientId), { recursive: true, force: true });

    const fresh = {
      clientId,
      status: "not_connected",
      qrDataUrl: null,
      phone: "",
      name: "",
      lastError: "",
      updatedAt: new Date().toISOString(),
      sock: null,
      starting: false
    };

    sessions.set(clientId, fresh);
    await saveQrStatus(fresh);
    res.json({ ok: true, ...publicStatus(fresh) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Unable to logout." });
  }
});

app.post("/api/qr/send", async (req, res) => {
  try {
    auth(req);
    const clientId = getClientId(req);
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const message = String(req.body?.message || "").trim();

    if (!phone || !message) {
      res.status(400).json({ ok: false, error: "phone and message are required." });
      return;
    }

    const session = sessions.get(clientId);
    if (!session?.sock || session.status !== "connected") {
      res.status(409).json({ ok: false, error: "WhatsApp QR is not connected." });
      return;
    }

    const sent = await session.sock.sendMessage(phone + "@s.whatsapp.net", { text: message });
    const firestore = db();

    if (firestore) {
      await firestore.collection("whatsappMessages").doc(sent.key?.id || crypto.randomUUID()).set({
        id: sent.key?.id || "",
        clientId,
        source: "whatsapp_qr",
        channel: "whatsapp_qr",
        direction: "outbound",
        phone,
        message,
        timestamp: FieldValue.serverTimestamp(),
        whatsappMessageId: sent.key?.id || ""
      }, { merge: true });

      await firestore.collection("whatsappConversations").doc(clientId + "_" + phone).set({
        id: clientId + "_" + phone,
        clientId,
        source: "whatsapp_qr",
        channel: "whatsapp_qr",
        phone,
        lastMessage: message,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({ ok: true, phone, message });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Unable to send WhatsApp message." });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "S&A Connect QR endpoint not found." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("S&A Connect QR Service listening on port " + PORT);
});
