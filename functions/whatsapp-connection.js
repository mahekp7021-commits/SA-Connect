import {getDb,json,getClientIdFromFirebaseToken,getWhatsAppConnection} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod!=="GET") return json({error:"Method not allowed."},405);
  try{
    const {clientId}=await getClientIdFromFirebaseToken(event);
    const c=await getWhatsAppConnection(clientId);
    if(!c) return json({connected:false});
    return json({
      connected:c.status==="connected",
      phoneNumberId:c.phoneNumberId,
      wabaId:c.wabaId,
      displayPhoneNumber:c.displayPhoneNumber||"",
      verifiedName:c.verifiedName||"",
      qualityRating:c.qualityRating||""
    });
  }catch(e){
    return json({error:e.message||"Unable to load connection."},500);
  }
}
