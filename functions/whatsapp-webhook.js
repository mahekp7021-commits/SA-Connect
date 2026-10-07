import crypto from "node:crypto";
import {getDb,json,getEnv,FieldValue,conversationId} from "./_shared.js";

function header(event,name){
  const headers=event.headers||{};
  return headers[name]||headers[name.toLowerCase()]||headers[name.toUpperCase()]||"";
}

function verifySignature(event){
  const secret=getEnv("META_APP_SECRET");
  if(!secret) return true;
  const signature=header(event,"x-hub-signature-256");
  if(!signature.startsWith("sha256=")) return false;
  const expected=crypto
    .createHmac("sha256",secret)
    .update(Buffer.from(event.rawBody||event.body||"","utf8"))
    .digest("hex");
  const received=signature.slice(7);
  if(received.length!==expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected));
}

function messageText(msg){
  const type=msg.type||"unknown";
  if(type==="text") return msg.text?.body||"";
  if(type==="button") return msg.button?.text||"";
  if(type==="interactive"){
    return msg.interactive?.button_reply?.title
      ||msg.interactive?.list_reply?.title
      ||"";
  }
  if(type==="image") return msg.image?.caption||"[Image]";
  if(type==="video") return msg.video?.caption||"[Video]";
  if(type==="document") return msg.document?.caption||"[Document]";
  if(type==="audio") return "[Audio]";
  if(type==="sticker") return "[Sticker]";
  if(type==="location") return "[Location]";
  if(type==="contacts") return "[Contact]";
  return `[${type}]`;
}

async function upsertLead(db,clientId,phone,name,text){
  if(!phone) return null;
  const snap=await db.collection("leads")
    .where("clientId","==",clientId)
    .where("phone","==",phone)
    .limit(1)
    .get();

  if(!snap.empty){
    const ref=snap.docs[0].ref;
    await ref.set({
      name:name||snap.docs[0].data()?.name||phone,
      phone,
      source:"whatsapp_api",
      channel:"whatsapp_business_api",
      requirement:text||snap.docs[0].data()?.requirement||"",
      message:text||snap.docs[0].data()?.message||"",
      updatedAt:FieldValue.serverTimestamp()
    },{merge:true});
    return ref.id;
  }

  const ref=await db.collection("leads").add({
    clientId,
    name:name||phone,
    phone,
    email:"",
    state:"",
    city:"",
    requirement:text||"",
    message:text||"",
    source:"whatsapp_api",
    channel:"whatsapp_business_api",
    status:"new",
    notes:"",
    tag:"",
    priority:"normal",
    budget:"",
    leadType:"whatsapp",
    createdAt:FieldValue.serverTimestamp(),
    updatedAt:FieldValue.serverTimestamp()
  });
  return ref.id;
}

export async function handler(event){
  if(event.httpMethod==="GET"){
    const p=new URL(event.rawUrl||event.url).searchParams;
    if(p.get("hub.mode")!=="subscribe" || p.get("hub.verify_token")!==getEnv("META_WA_VERIFY_TOKEN")){
      return new Response("Forbidden",{status:403});
    }
    return new Response(p.get("hub.challenge")||"",{status:200});
  }

  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  if(!verifySignature(event)) return json({error:"Invalid webhook signature."},403);

  try{
    const payload=JSON.parse(event.body||"{}");
    const db=getDb();

    for(const entry of payload.entry||[]){
      for(const change of entry.changes||[]){
        const value=change.value||{};
        const phoneNumberId=value.metadata?.phone_number_id||"";
        if(!phoneNumberId) continue;

        const connSnap=await db.collection("whatsappConnections").doc(phoneNumberId).get();
        if(!connSnap.exists){
          console.warn("No WhatsApp connection for phoneNumberId:",phoneNumberId);
          continue;
        }

        const conn=connSnap.data();
        const clientId=String(conn.clientId||"").trim();
        if(!clientId) continue;

        for(const contact of value.contacts||[]){
          if(contact.wa_id){
            await db.collection("whatsappContacts").doc(`${clientId}_${contact.wa_id}`).set({
              clientId,
              phone:contact.wa_id,
              name:contact.profile?.name||"",
              updatedAt:FieldValue.serverTimestamp()
            },{merge:true});
          }
        }

        for(const msg of value.messages||[]){
          const phone=String(msg.from||"").replace(/\D/g,"");
          if(!phone) continue;

          const cid=conversationId(clientId,phone);
          const mid=String(msg.id||`${cid}_${Date.now()}`);
          const messageRef=db.collection("whatsappMessages").doc(mid);

          // Meta may retry webhook deliveries. Never create a second message,
          // second lead update, or second unread count for the same message ID.
          const existing=await messageRef.get();
          if(existing.exists) continue;

          const type=msg.type||"unknown";
          const text=messageText(msg);
          const contact=value.contacts?.find(c=>c.wa_id===phone);
          const contactName=contact?.profile?.name||phone;

          await messageRef.set({
            clientId,
            conversationId:cid,
            phone,
            text,
            body:text,
            type,
            direction:"inbound",
            fromCustomer:true,
            fromMe:false,
            status:"received",
            messageId:msg.id||"",
            timestamp:FieldValue.serverTimestamp(),
            createdAt:FieldValue.serverTimestamp(),
            source:"whatsapp_api",
            channel:"whatsapp_business_api"
          });

          await db.collection("whatsappConversations").doc(cid).set({
            clientId,
            phone,
            contactName,
            lastMessage:text,
            lastMessageAt:FieldValue.serverTimestamp(),
            unreadCount:FieldValue.increment(1),
            source:"whatsapp_api",
            channel:"whatsapp_business_api",
            updatedAt:FieldValue.serverTimestamp()
          },{merge:true});

          const leadId=await upsertLead(db,clientId,phone,contactName,text);
          if(leadId){
            await db.collection("leadTimeline").add({
              clientId,
              leadId,
              type:"whatsapp_incoming",
              title:"WhatsApp message received",
              description:text||"Incoming WhatsApp message",
              createdBy:"whatsapp_webhook",
              createdByName:contactName,
              createdAt:FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    return json({ok:true});
  }catch(e){
    console.error("WhatsApp webhook processing failed:",e);
    return json({error:"Webhook processing failed."},500);
  }
}
