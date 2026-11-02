// Password gate for the whole app (pages and API). See lib/accessControl.js for the rules.
import { NextResponse } from "next/server";
import { accessConfig, checkAccess, LOCKED_MESSAGE } from "./lib/accessControl.js";
import { isCronRequest, CRON_PATHS } from "./lib/cronAuth.js";

const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

export function middleware(req) {
  // Vercel Cron cannot send the password. Exactly these paths, and only with the cron secret, skip it (the route checks again).
  if (CRON_PATHS.includes(req.nextUrl.pathname) && isCronRequest(req.headers.get("authorization"), process.env)) return NextResponse.next();

  const result = checkAccess(req.headers.get("authorization"), accessConfig(process.env));

  if (result.allowed) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", PRIVATE_HEADERS["X-Robots-Tag"]); // a private tool should never be indexed
    return res;
  }
  if (result.reason === "not_configured") {
    return new NextResponse(LOCKED_MESSAGE, { status: 503, headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { ...PRIVATE_HEADERS, "WWW-Authenticate": 'Basic realm="VertexRank", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Everything except Next's static build assets (they contain no data and the browser must be able to load them).
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
