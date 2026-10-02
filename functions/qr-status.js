import { json, getClientIdFromFirebaseToken, getEnv } from "./_shared.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json({ error: "Method not allowed." }, 405);

  try {
    const { clientId } = await getClientIdFromFirebaseToken(event);
    const base = getEnv("QR_SERVICE_URL").replace(/\/$/, "");
    const serviceKey = getEnv("QR_SERVICE_KEY");

    if (!base || !serviceKey) {
      return json({ error: "QR service is not configured on the backend." }, 409);
    }

    const response = await fetch(base + "/api/qr/status?clientId=" + encodeURIComponent(clientId), {
      headers: {
        "x-qr-service-key": serviceKey,
        "x-client-id": clientId
      }
    });

    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text || "QR service returned an invalid response." }; }
    return json(body, response.status);
  } catch (e) {
    return json({ error: e.message || "Unable to load QR status." }, 500);
  }
}
