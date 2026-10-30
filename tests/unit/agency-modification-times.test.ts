import {expect,it} from "vitest";
import {agencyModificationOutboundTime,normalizeAgencyModificationTimes} from "@/lib/agency-modification-times";
it("opens a Medmar modification at the departure time, not the estimated landing",()=>{
 expect(agencyModificationOutboundTime({booking_service_kind:"formula_medmar_pozzuoli",time:"09:40:00",arrival_time:"10:40:00"})).toBe("09:40");
});
it("prefers the explicit ferry departure and preserves ordinary transfer arrival semantics",()=>{
 expect(agencyModificationOutboundTime({booking_service_kind:"formula_snav",outbound_time:"09:40",time:"10:45"})).toBe("09:40");
 expect(agencyModificationOutboundTime({booking_service_kind:"transfer_train_hotel",time:"09:40",arrival_time:"10:40"})).toBe("10:40");
});
it("stores requested departure and derived arrival together for approval",()=>{
 expect(normalizeAgencyModificationTimes({ferry_departure_time:"11:00",hotel_id:"hotel"},"formula_medmar_pozzuoli")).toEqual({time:"11:00",outbound_time:"11:00",arrival_time:"12:00",hotel_id:"hotel"});
});
it("uses the requested formula for its crossing duration",()=>{
 expect(normalizeAgencyModificationTimes({ferry_departure_time:"11:00",booking_service_kind:"formula_snav"},"formula_medmar_pozzuoli").arrival_time).toBe("12:05");
});
it.each(["25:00","09:99",null])("rejects malformed departures (%s)",value=>{expect(()=>normalizeAgencyModificationTimes({ferry_departure_time:value},"formula_medmar_pozzuoli")).toThrow();});
it("rejects ferry times for non-formula services and preserves legacy requests",()=>{
 expect(()=>normalizeAgencyModificationTimes({ferry_departure_time:"11:00"},"transfer_port_hotel")).toThrow();
 expect(normalizeAgencyModificationTimes({arrival_time:"11:00"},"formula_medmar_pozzuoli")).toEqual({arrival_time:"11:00"});
});
