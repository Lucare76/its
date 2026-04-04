import { redirect } from "next/navigation";

export default function ContactsRedirectPage() {
  redirect("/login");
}
