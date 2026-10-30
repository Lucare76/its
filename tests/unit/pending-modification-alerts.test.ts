import {expect,it} from "vitest";
import {newPendingModificationIds} from "@/lib/pending-modification-alerts";
it("does not replay alerts for requests that existed when ITS was opened",()=>{expect(newPendingModificationIds(null,new Set(["existing"])) ).toEqual([]);});
it("alerts when a request appears after an empty baseline",()=>{expect(newPendingModificationIds(new Set(),new Set(["new"])) ).toEqual(["new"]);});
it("does not alert twice when Realtime and reconciliation return the same request",()=>{expect(newPendingModificationIds(new Set(["new"]),new Set(["new"])) ).toEqual([]);});
it("detects a new request even when another request was resolved and the count stays unchanged",()=>{expect(newPendingModificationIds(new Set(["resolved"]),new Set(["replacement"])) ).toEqual(["replacement"]);});
it("does not announce approval or rejection as a new incoming request",()=>{expect(newPendingModificationIds(new Set(["resolved"]),new Set()) ).toEqual([]);});
it("a fresh session baseline does not replay another session's alerts",()=>{expect(newPendingModificationIds(null,new Set(["other-session-request"])) ).toEqual([]);});
