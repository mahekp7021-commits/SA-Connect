import {getDb,json,slugFromEvent,FieldValue,normalizePhone} from "./_shared.js";

export async function handler(event){
  if(event.httpMethod==="OPTIONS") return new Response(null,{status:204});
  if(event.httpMethod!=="POST") return json({error:"Method not allowed."},405);

  try{
    const body=JSON.parse(event.body||"{}");

    if(String(body.website||"").trim()) {
      return json({error:"Unable to submit lead."},400);
    }

    const name=String(body.name||"").trim();
    const phone=normalizePhone(body.phone||"");
    const email=String(body.email||"").trim();
    const state=String(body.state||"").trim();
    const city=String(body.city||"").trim();

    const tradingExperience=String(body.tradingExperience||"").trim();
    const traderStatus=String(body.traderStatus||"").trim();
    const lossExperience=String(body.lossExperience||"").trim();
    const lossSegment=String(body.lossSegment||"").trim();
    const tradingCapital=String(body.tradingCapital||"").trim();
    const topic=String(body.topic||"").trim();
    const message=String(body.message||"").trim();

    const slug=String(body.slug||slugFromEvent(event)).trim();

    if(
      name.length<1 ||
      name.length>120 ||
      phone.length<7 ||
      phone.length>20 ||
      email.length>160 ||
      state.length<1 ||
      state.length>100 ||
      city.length<1 ||
      city.length>100 ||
      tradingExperience.length<1 ||
      tradingExperience.length>100 ||
      traderStatus.length<1 ||
      traderStatus.length>100 ||
      lossExperience.length<1 ||
      lossExperience.length>100 ||
      lossSegment.length<1 ||
      lossSegment.length>100 ||
      tradingCapital.length<1 ||
      tradingCapital.length>100 ||
      topic.length<1 ||
      topic.length>200 ||
      message.length<1 ||
      message.length>1000
    ){
      return json({error:"Please complete all required fields."},400);
    }

    if(!slug) {
      return json({error:"Landing page slug is missing."},400);
    }

    const snap=await getDb()
      .collection("landingPages")
      .where("slug","==",slug)
      .limit(1)
      .get();

    if(snap.empty || snap.docs[0].data().enabled!==true) {
      return json({error:"Landing page is not available."},404);
    }

    const p=snap.docs[0].data();
    const clientId=String(p.clientId||"").trim();

    if(!clientId) {
      return json({error:"Invalid landing page."},500);
    }

    /*
     * Keep "requirement" for compatibility with the existing
     * S&A Connect Android Lead model while also storing all
     * trader-specific fields separately.
     */
    const ref=await getDb().collection("leads").add({
      clientId,
      name,
      phone,
      email,
      state,
      city,

      requirement:message,

      tradingExperience,
      traderStatus,
      lossExperience,
      lossSegment,
      tradingCapital,
      topic,
      message,

      source:"landing_page",
      channel:"web_form",
      status:"new",
      notes:"",
      landingPageSlug:slug,
      createdAt:FieldValue.serverTimestamp(),
      createdAtServer:new Date().toISOString()
    });

    return json({ok:true,leadId:ref.id},201);

  }catch(e){
    console.error(e);
    return json({error:"Unable to submit lead."},500);
  }
}
