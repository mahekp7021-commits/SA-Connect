import {getDb,json,getClientIdFromFirebaseToken,encryptSecret,graphFetch} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  try{
    const {clientId}=await getClientIdFromFirebaseToken(event);
    const b=JSON.parse(event.body||"{}");
    const phoneNumberId=String(b.phoneNumberId||"").trim();
    const wabaId=String(b.wabaId||"").trim();
    const accessToken=String(b.accessToken||"").trim();
    if(!phoneNumberId||!wabaId||!accessToken) return json({error:"Phone Number ID, WABA ID and Access Token are required."},400);
    const check=await graphFetch(`/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,quality_rating`,accessToken);
    if(!check.res.ok) return json({error:check.body?.error?.message||"Meta rejected the credentials."},400);
    const d=check.body;
    const db=getDb();
    await db.collection("whatsappConnections").doc(phoneNumberId).set({
      clientId,wabaId,phoneNumberId,
      displayPhoneNumber:d.display_phone_number||"",
      verifiedName:d.verified_name||"",
      qualityRating:d.quality_rating||"",
      accessTokenEncrypted:encryptSecret(accessToken),
      status:"connected",
      updatedAt:new Date().toISOString()
    },{merge:true});
    const sub=await graphFetch(`/${encodeURIComponent(wabaId)}/subscribed_apps`,accessToken,{method:"POST",body:"{}"});
    return json({
      ok:true,
      message:sub.res.ok?"WhatsApp connected and webhook subscription requested.":"WhatsApp credentials verified and saved; webhook subscription needs attention.",
      phoneNumberId,wabaId,
      displayPhoneNumber:d.display_phone_number||"",
      verifiedName:d.verified_name||"",
      webhookSubscribed:sub.res.ok
    });
  }catch(e){
    console.error(e);
    return json({error:e.message||"Unable to connect WhatsApp."},500);
  }
}
