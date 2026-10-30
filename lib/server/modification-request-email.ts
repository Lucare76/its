import { sendEmail, type SendEmailResult } from "@/lib/server/send-email";
import { emailHtml, emailDataTable, emailButton } from "@/lib/server/email-layout";
function escapeHtml(value: string) {
 return value.replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]!));
}
export async function sendModificationRequestEmail(input:{customerName:string; changes:Record<string,unknown>; hotelName:string|null; requestId:string}):Promise<SendEmailResult> {
 const to=process.env.OPS_NOTIFY_EMAIL?.trim() || "info@ischiatransferservice.it";
 const appUrl=process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/,"") || "https://ischia-transfer.vercel.app";
 const labels:Record<string,string>={arrival_date:"Data andata",arrival_time:"Arrivo a destinazione / stimato a Ischia",time:"Partenza nave dalla terraferma",outbound_time:"Partenza nave dalla terraferma",departure_date:"Data ritorno",departure_time:"Ora ritorno",pax:"Passeggeri",hotel_id:"Hotel",booking_service_kind:"Tipologia servizio",phone:"Telefono",notes:"Note"};
 const rows:[string,string][]=Object.entries(input.changes).filter(([key])=>key!=="outbound_time" || !("time" in input.changes)).map(([key,value])=>[labels[key]??key,key==="hotel_id"&&input.hotelName?input.hotelName:String(value??"—")]);
 try { return await sendEmail({to,subject:`Richiesta modifica — ${input.customerName}`,html:emailHtml(`<h2>Richiesta modifica prenotazione</h2><p>Un’agenzia ha richiesto una modifica. La richiesta attende la valutazione dell’operatore.</p>${emailDataTable([["Cliente",escapeHtml(input.customerName)],...rows.map(([label,value]):[string,string]=>[label,escapeHtml(value)]),["Riferimento",escapeHtml(input.requestId)]])}${emailButton("Gestisci richiesta",`${appUrl}/richieste-modifica`)}`,{title:"Richiesta modifica"}),text:`Richiesta modifica\nCliente: ${input.customerName}\n${rows.map(([label,value])=>`${label}: ${value}`).join("\n")}\nRiferimento: ${input.requestId}\nGestisci: ${appUrl}/richieste-modifica`}); }
 catch { return {ok:false,error:"Invio notifica modifica fallito."}; }
}
