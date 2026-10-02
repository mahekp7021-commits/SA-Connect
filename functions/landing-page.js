import {getDb,json,slugFromEvent} from "./_shared.js";
export async function handler(event){
  if(event.httpMethod==="OPTIONS") return new Response(null,{status:204});
  if(event.httpMethod!=="GET") return json({error:"Method not allowed."},405);
  try{
    const slug=slugFromEvent(event);
    if(!slug) return json({error:"Missing landing page slug."},400);
    const snap=await getDb().collection("landingPages").where("slug","==",slug).limit(1).get();
    if(snap.empty) return json({error:"Landing page not found."},404);
    const page=snap.docs[0].data();
    if(page.enabled!==true) return json({error:"This landing page is not published."},404);
    const clientId=String(page.clientId||"").trim();
    if(!clientId) return json({error:"Invalid landing page configuration."},500);
    const client=await getDb().collection("clients").doc(clientId).get();
    const c=client.exists?client.data():{};
    return json({pageName:page.pageName||"Contact Us",businessName:c.businessName||c.ownerName||"Business",slug,clientId});
  }catch(e){
    console.error(e);
    return json({error:"Unable to load landing page."},500);
  }
}
