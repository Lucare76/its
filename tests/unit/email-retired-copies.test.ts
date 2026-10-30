import { afterEach, expect, it, vi } from "vitest";
import { resendFetch } from "@/lib/server/send-email";
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
it("keeps the operational recipient and Luca copy while removing retired CC/BCC", async () => {
 vi.stubEnv("EMAIL_TEST_REDIRECT", "");
 const fetch = vi.fn().mockResolvedValue(new Response("{}", {status:200})); vi.stubGlobal("fetch", fetch);
 await resendFetch("test-key", {to:["info@ischiatransferservice.it"], cc:["Rennasday@gmail.com"], bcc:["rennasday@gmail.com", "luca_renna@hotmail.com"], subject:"Test"});
 const body=JSON.parse(fetch.mock.calls[0][1].body);
 expect(body.to).toEqual(["info@ischiatransferservice.it"]);
 expect(body.bcc).toEqual(["luca_renna@hotmail.com"]);
 expect(body.cc).toBeUndefined();
});
it("preserves other explicit copies and the existing test redirect behavior", async () => {
 vi.stubEnv("EMAIL_TEST_REDIRECT", "test@example.com");
 const fetch=vi.fn().mockResolvedValue(new Response("{}", {status:200})); vi.stubGlobal("fetch", fetch);
 await resendFetch("test-key", {to:["agency@example.com"], cc:["ops@example.com"], bcc:["luca_renna@hotmail.com"]});
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({to:["test@example.com"]});
 expect(JSON.parse(fetch.mock.calls[0][1].body).bcc).toBeUndefined();
});
