import {getDb,json,getEnv,FieldValue,conversationId} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod==="GET"){
    const p=new URL(event.rawUrl||event.url).searchParams;
    if(p.get("hub.verify_token")!==getEnv("META_WA_VERIFY_TOKEN")) return new Response("Forbidden",{status:403});
    return new Response(p.get("hub.challenge")||"",{status:200});
  }
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  try{
    const payload=JSON.parse(event.body||"{}");
    for(const entry of payload.entry||[]){
      for(const change of entry.changes||[]){
        const value=change.value||{};
        const phoneNumberId=value.metadata?.phone_number_id||"";
        if(!phoneNumberId) continue;
        const db=getDb();
        const connSnap=await db.collection("whatsappConnections").doc(phoneNumberId).get();
        if(!connSnap.exists){ console.warn("No connection for",phoneNumberId); continue; }
        const conn=connSnap.data();
        const clientId=conn.clientId;
        if(!clientId) continue;
        for(const contact of value.contacts||[]){
          if(contact.wa_id){
            await db.collection("whatsappContacts").doc(`${clientId}_${contact.wa_id}`).set({
              clientId,phone:contact.wa_id,name:contact.profile?.name||"",
              updatedAt:FieldValue.serverTimestamp()
            },{merge:true});
          }
        }
        for(const msg of value.messages||[]){
          const phone=msg.from||"";
          const cid=conversationId(clientId,phone);
          let text="";
          const type=msg.type||"unknown";
          if(type==="text") text=msg.text?.body||"";
          else if(type==="button") text=msg.button?.text||"";
          else if(type==="interactive") text=msg.interactive?.button_reply?.title||msg.interactive?.list_reply?.title||"";
          else text=`[${type}]`;
          const contact=value.contacts?.find(c=>c.wa_id===phone);
          const mid=msg.id||`${cid}_${Date.now()}`;
          await db.collection("whatsappMessages").doc(mid).set({
            clientId,conversationId:cid,phone,text,type,fromMe:false,status:"received",
            messageId:msg.id||"",timestamp:FieldValue.serverTimestamp(),
            source:"whatsapp_api",channel:"whatsapp_business_api"
          },{merge:true});
          await db.collection("whatsappConversations").doc(cid).set({
            clientId,phone,contactName:contact?.profile?.name||"",
            lastMessage:text,lastMessageAt:FieldValue.serverTimestamp(),
            unreadCount:FieldValue.increment(1),source:"whatsapp_api",
            channel:"whatsapp_business_api",updatedAt:FieldValue.serverTimestamp()
          },{merge:true});
        }
      }
    }
    return json({ok:true});
  }catch(e){
    console.error(e);
    return json({error:"Webhook processing failed."},500);
  }
}
