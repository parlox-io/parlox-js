import { geolocation, next } from "@vercel/functions";

export default function middleware(request: Request) {
  if (geolocation(request).country === "XX") return new Response("Not available here", { status: 451 });
  return next();
}

export const config = { matcher: ["/((?!assets/).*)"] };
