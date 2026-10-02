import { json, getClientIdFromFirebaseToken, getEnv, authorizationHeader } from "./_shared.js";
export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    await getClientIdFromFirebaseToken(event);
    const base = getEnv("QR_SERVICE_URL").replace(/\/$/, "");
    if (!base) return json({ error: "QR service is not configured on the backend." }, 409);
    const response = await fetch(`${base}/api/qr/logout`, {
      method: "POST",
      headers: { Authorization: authorizationHeader(event) }
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text || "QR service returned an invalid response." }; }
    return json(body, response.status);
  } catch (e) {
    return json({ error: e.message || "Unable to disconnect QR service." }, 500);
  }
}
