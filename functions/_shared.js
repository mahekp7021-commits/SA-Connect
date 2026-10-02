import crypto from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) return initializeApp({ credential: cert(JSON.parse(raw)) });
  return initializeApp();
}

export function getDb(){ adminApp(); return getFirestore(); }
export function getFirebaseAuth(){ adminApp(); return getAuth(); }
export { FieldValue };

export function json(data,status=200,extraHeaders={}){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type, Authorization",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
      ...extraHeaders
    }
  });
}

export function getEnv(name){ return process.env[name] || ""; }
export function normalizePhone(v=""){ return String(v).replace(/\D/g,""); }
export function conversationId(clientId,phone){ return `${clientId}_${normalizePhone(phone)}`; }

export function slugFromEvent(event){
  const url = new URL(event.rawUrl || event.url || "https://example.invalid");
  return (url.searchParams.get("slug") || event.queryStringParameters?.slug || "").trim().replace(/^\/|\/$/g,"");
}

export function graphVersion(){ return getEnv("META_WA_GRAPH_VERSION") || "v25.0"; }

function header(event,name){
  const headers=event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

export function authorizationHeader(event){ return header(event,"authorization"); }

export async function getClientIdFromFirebaseToken(request){
  const h=authorizationHeader(request);
  if(!h.toLowerCase().startsWith("bearer ")) throw new Error("Missing Firebase authorization token.");
  const decoded=await getFirebaseAuth().verifyIdToken(h.slice(7).trim());
  const u=await getDb().collection("users").doc(decoded.uid).get();
  const clientId=u.data()?.clientId||"";
  if(!clientId) throw new Error("Client profile not found.");
  return {uid:decoded.uid,clientId};
}

function keyBytes(){
  const secret=getEnv("WHATSAPP_TOKEN_ENCRYPTION_KEY");
  if(!secret) throw new Error("WHATSAPP_TOKEN_ENCRYPTION_KEY is not configured.");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain){
  const iv=crypto.randomBytes(12); const key=keyBytes();
  const c=crypto.createCipheriv("aes-256-gcm",key,iv);
  const enc=Buffer.concat([c.update(plain,"utf8"),c.final()]);
  const tag=c.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(payload){
  const [ivB,tagB,dataB]=String(payload).split(".");
  if(!ivB||!tagB||!dataB) throw new Error("Invalid encrypted secret.");
  const d=crypto.createDecipheriv("aes-256-gcm",keyBytes(),Buffer.from(ivB,"base64url"));
  d.setAuthTag(Buffer.from(tagB,"base64url"));
  return Buffer.concat([d.update(Buffer.from(dataB,"base64url")),d.final()]).toString("utf8");
}

export async function getWhatsAppConnection(clientId){
  const db=getDb();
  const snap=await db.collection("whatsappConnections").where("clientId","==",clientId).limit(1).get();
  if(snap.empty) return null;
  const d=snap.docs[0];
  return {id:d.id,...d.data()};
}

export async function resolveWhatsAppConnection(clientId,phoneNumberId=""){
  const db=getDb();
  if(phoneNumberId){
    const d=await db.collection("whatsappConnections").doc(phoneNumberId).get();
    if(d.exists&&d.data()?.clientId===clientId) return {id:d.id,...d.data()};
  }
  return getWhatsAppConnection(clientId);
}

export async function graphFetch(path, token, options={}){
  const url=`https://graph.facebook.com/${graphVersion()}${path}`;
  const res=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`,"Content-Type":"application/json"}});
  const text=await res.text(); let body;
  try{body=JSON.parse(text)}catch{body={raw:text}}
  return {res,body};
}
