import { redirect } from "next/navigation";

/** Old bookmarks now open the current ticketing section. */
export default function BigliettiMultipliPage() {
  redirect("/biglietti-medmar");
}
