export {
  BUS_LINES_2026,
  findBusLineByCode,
  findBusStopsByCity,
  findNearestBusStop,
  resolveBusStop
} from "@/lib/server/bus-lines-catalog";

export type { BusLineCatalogEntry, BusLineStop } from "@/lib/server/bus-lines-catalog";
