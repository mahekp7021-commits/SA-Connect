import {getDb,json,getClientIdFromFirebaseToken,getWhatsAppConnection} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  try{
    const {clientId}=await getClientIdFromFirebaseToken(event);
    const c=await getWhatsAppConnection(clientId);
    if(!c) return json({ok:true,message:"Already disconnected."});
    await getDb().collection("whatsappConnections").doc(c.phoneNumberId).set({
      status:"disconnected",
      accessTokenEncrypted:"",
      updatedAt:new Date().toISOString()
    },{merge:true});
    return json({ok:true,message:"WhatsApp disconnected."});
  }catch(e){
    return json({error:e.message||"Unable to disconnect."},500);
  }
}
