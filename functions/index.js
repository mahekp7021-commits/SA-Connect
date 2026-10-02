import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { handler as landingPage } from "./landing-page.js";
import { handler as submitLead } from "./submit-lead.js";
import { handler as connectWhatsApp } from "./connect-whatsapp.js";
import { handler as whatsappConnection } from "./whatsapp-connection.js";
import { handler as disconnectWhatsApp } from "./disconnect-whatsapp.js";
import { handler as sendWhatsApp } from "./send-whatsapp.js";
import { handler as whatsappWebhook } from "./whatsapp-webhook.js";
import { handler as qrStart } from "./qr-start.js";
import { handler as qrStatus } from "./qr-status.js";
import { handler as qrLogout } from "./qr-logout.js";

setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

const routes = {
  "/api/landing-page": landingPage,
  "/api/submit-lead": submitLead,
  "/api/connect-whatsapp": connectWhatsApp,
  "/api/whatsapp-connection": whatsappConnection,
  "/api/disconnect-whatsapp": disconnectWhatsApp,
  "/api/send-whatsapp": sendWhatsApp,
  "/api/whatsapp-webhook": whatsappWebhook,
  "/api/qr/start": qrStart,
  "/api/qr/status": qrStatus,
  "/api/qr/logout": qrLogout
};

function toEvent(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "localhost";
  const rawUrl = `${protocol}://${host}${req.originalUrl || req.url || "/"}`;
  return {
    httpMethod: req.method,
    headers: req.headers || {},
    body: typeof req.body === "string" ? req.body : (req.body == null ? "" : JSON.stringify(req.body)),
    rawUrl,
    url: rawUrl,
    queryStringParameters: req.query || {}
  };
}

async function dispatch(req, res) {
  const path = (req.path || req.originalUrl || "").split("?")[0].replace(/\/$/, "") || "/";
  const handler = routes[path];
  if (!handler) {
    res.status(404).json({ error: "S&A Connect API endpoint not found." });
    return;
  }
  try {
    const response = await handler(toEvent(req));
    res.status(response.status || 200);
    response.headers?.forEach?.((value, key) => res.setHeader(key, value));
    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error("API dispatch error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

export const api = onRequest({ cors: true }, dispatch);
