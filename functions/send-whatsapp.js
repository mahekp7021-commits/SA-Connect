import {getDb,json,getClientIdFromFirebaseToken,resolveWhatsAppConnection,decryptSecret,graphFetch,conversationId,FieldValue,getEnv,authorizationHeader} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  try{
    const {clientId}=await getClientIdFromFirebaseToken(event);
    const b=JSON.parse(event.body||"{}");
    const to=String(b.to||"").replace(/\D/g,"");
    const message=String(b.message||"").trim();
    if(to.length<8||!message) return json({error:"Recipient and message are required."},400);
    const channel=String(b.channel||"whatsapp_business_api");
    if(channel==="whatsapp_qr"){
      const qrUrl=getEnv("QR_SERVICE_URL");
      if(!qrUrl) return json({error:"QR service is not configured on the backend."},409);
      const r=await fetch(qrUrl.replace(/\/$/,"")+"/api/qr/send",{
        method:"POST",
        headers:{"Content-Type":"application/json",Authorization:authorizationHeader(event)},
        body:JSON.stringify({to,message})
      });
      const t=await r.text(); let j;
      try{j=JSON.parse(t)}catch{j={error:t}};
      return json(j,r.status);
    }
    const c=await resolveWhatsAppConnection(clientId);
    if(!c||c.status!=="connected"||!c.accessTokenEncrypted) return json({error:"WhatsApp API is not connected."},409);
    const token=decryptSecret(c.accessTokenEncrypted);
    const result=await graphFetch(`/${encodeURIComponent(c.phoneNumberId)}/messages`,token,{
      method:"POST",
      body:JSON.stringify({messaging_product:"whatsapp",to,type:"text",text:{preview_url:false,body:message}})
    });
    if(!result.res.ok) return json({error:result.body?.error?.message||"Meta message send failed."},400);
    const waId=result.body?.messages?.[0]?.id||"";
    const cid=conversationId(clientId,to);
    const db=getDb();
    await db.collection("whatsappMessages").doc(waId||`${cid}_${Date.now()}`).set({
      clientId,conversationId:cid,phone:to,text:message,type:"text",
      fromMe:true,status:"sent",messageId:waId,source:"whatsapp_api",
      channel:"whatsapp_business_api",timestamp:FieldValue.serverTimestamp()
    });
    await db.collection("whatsappConversations").doc(cid).set({
      clientId,phone:to,lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),
      unreadCount:0,source:"whatsapp_api",channel:"whatsapp_business_api",
      updatedAt:FieldValue.serverTimestamp()
    },{merge:true});
    return json({ok:true,messageId:waId});
  }catch(e){
    console.error(e);
    return json({error:e.message||"Unable to send WhatsApp message."},500);
  }
}
