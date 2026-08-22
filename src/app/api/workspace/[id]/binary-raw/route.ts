/**
 * Same handler as /binary.
 *
 * The composer posts files over 9MB here so a custom Node server can stream
 * them past Next's body cap. Under `next dev` this route used to 404, which
 * is why dropping a 37MB client.dll reported "Couldn't save … HTTP 404".
 */
export { POST } from "../binary/route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";
