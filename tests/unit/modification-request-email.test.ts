import {afterEach,beforeEach,expect,it,vi} from "vitest";
const {send}=vi.hoisted(()=>({send:vi.fn()}));
vi.mock("@/lib/server/send-email",()=>({sendEmail:send}));
import {sendModificationRequestEmail} from "@/lib/server/modification-request-email";
beforeEach(()=>{send.mockReset().mockResolvedValue({ok:true});vi.stubEnv("OPS_NOTIFY_EMAIL","info@ischiatransferservice.it");});
afterEach(()=>vi.unstubAllEnvs());
const input={customerName:"Test cliente",changes:{hotel_id:"hotel"},hotelName:"HOTEL CASTIGLIONE VILLAGE",requestId:"request"};
it("routes the hotel modification to the operational mailbox with a readable hotel name",async()=>{
 expect((await sendModificationRequestEmail(input)).ok).toBe(true);
 expect(send.mock.calls[0][0]).toMatchObject({to:"info@ischiatransferservice.it",text:expect.stringContaining("Hotel: HOTEL CASTIGLIONE VILLAGE")});
});
it("uses Info fallback and escapes untrusted values in the HTML",async()=>{vi.stubEnv("OPS_NOTIFY_EMAIL","");await sendModificationRequestEmail({...input,hotelName:"<b>Hotel</b>"});expect(send.mock.calls[0][0].to).toBe("info@ischiatransferservice.it");expect(send.mock.calls[0][0].html).toContain("&lt;b&gt;Hotel&lt;/b&gt;");});
it("propagates failures and skipped sends without claiming success",async()=>{send.mockResolvedValueOnce({ok:false,skipped:true});expect((await sendModificationRequestEmail(input)).skipped).toBe(true);send.mockRejectedValueOnce(new Error("transport"));expect((await sendModificationRequestEmail(input)).ok).toBe(false);});
