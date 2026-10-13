import { redirect } from "next/navigation";

/** Seats became LP (IA v3.1 item 8); old links land on /lp. */
export default function Page() {
  redirect("/lp");
}
