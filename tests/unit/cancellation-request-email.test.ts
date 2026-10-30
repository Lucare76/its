import {afterEach,beforeEach,expect,it,vi} from "vitest";
const {send}=vi.hoisted(()=>({send:vi.fn()}));
vi.mock("@/lib/server/send-email",()=>({sendEmail:send}));
import {sendCancellationRequestEmail} from "@/lib/server/cancellation-request-email";
beforeEach(()=>{send.mockReset().mockResolvedValue({ok:true});vi.stubEnv("OPS_NOTIFY_EMAIL","info@ischiatransferservice.it");vi.stubEnv("NEXT_PUBLIC_APP_URL","https://ischia-transfer.vercel.app");});
afterEach(()=>vi.unstubAllEnvs());
const input={customerName:"Test cancellazione",cancelLegs:"both" as const,requestId:"test-request"};
it("notifies the operational mailbox independently of auth account email lists",async()=>{
 expect(await sendCancellationRequestEmail(input)).toEqual({ok:true});
 expect(send).toHaveBeenCalledWith(expect.objectContaining({to:"info@ischiatransferservice.it",subject:"Richiesta cancellazione — Test cancellazione",text:expect.stringContaining("Intero servizio")}));
 expect(send.mock.calls[0][0].html).toContain("/cancellazioni");
});
it("falls back to Info when the operational config is absent",async()=>{vi.stubEnv("OPS_NOTIFY_EMAIL","");await sendCancellationRequestEmail(input);expect(send.mock.calls[0][0].to).toBe("info@ischiatransferservice.it");});
it.each(["arrival","departure"] as const)("identifies the requested leg %s",async cancelLegs=>{await sendCancellationRequestEmail({...input,cancelLegs});expect(send.mock.calls[0][0].text).toContain(cancelLegs==="arrival"?"Solo andata":"Solo ritorno");});
it("returns provider failure instead of claiming success",async()=>{send.mockResolvedValue({ok:false,error:"provider rejected"});expect((await sendCancellationRequestEmail(input)).ok).toBe(false);});
it("preserves skipped delivery and handles transport failures",async()=>{send.mockResolvedValueOnce({ok:false,skipped:true});expect((await sendCancellationRequestEmail(input)).skipped).toBe(true);send.mockRejectedValueOnce(new Error("transport"));expect((await sendCancellationRequestEmail(input)).ok).toBe(false);});
it("escapes customer data in HTML",async()=>{await sendCancellationRequestEmail({...input,customerName:"<b>Cliente</b>"});expect(send.mock.calls[0][0].html).toContain("&lt;b&gt;Cliente&lt;/b&gt;");});
