import {getDb,json,slugFromEvent,FieldValue,normalizePhone} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod==="OPTIONS") return new Response(null,{status:204});
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);
  try{
    const body=JSON.parse(event.body||"{}");
    if(String(body.website||"").trim()) return json({error:"Unable to submit lead."},400);
    const name=String(body.name||"").trim();
    const phone=normalizePhone(body.phone||"");
    const email=String(body.email||"").trim();
    const state=String(body.state||"").trim();
    const city=String(body.city||"").trim();
    const requirement=String(body.requirement||"").trim();
    const slug=String(body.slug||slugFromEvent(event)).trim();
    if(name.length<2||phone.length<10||!state||!city) return json({error:"Please complete the required fields."},400);
    const snap=await getDb().collection("landingPages").where("slug","==",slug).limit(1).get();
    if(snap.empty||snap.docs[0].data().enabled!==true) return json({error:"Landing page is not available."},404);
    const p=snap.docs[0].data();
    const clientId=String(p.clientId||"");
    if(!clientId) return json({error:"Invalid landing page."},500);
    const ref=await getDb().collection("leads").add({
      clientId,name,phone,email,state,city,requirement,
      source:"landing_page",channel:"web_form",status:"new",notes:"",
      landingPageSlug:slug,createdAt:FieldValue.serverTimestamp(),
      createdAtServer:new Date().toISOString()
    });
    return json({ok:true,leadId:ref.id},201);
  }catch(e){
    console.error(e);
    return json({error:"Unable to submit lead."},500);
  }
}
