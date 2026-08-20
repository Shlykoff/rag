// proxy.ts
//
// Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`
// (same functionality, new name/export -- see
// node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md);
// `middleware.ts` still works but logs a deprecation warning on every
// `next dev`/`next build`, so this project uses the current convention.
//
// Standard `@supabase/ssr` Next.js proxy pattern: refreshes the session
// cookie on every request (a Supabase access token expires in ~1h; without
// this, a long-lived tab would silently start failing server-side auth
// checks) and gates the app's protected pages behind a valid session.
//
// `app/api/**` routes are deliberately excluded (see the matcher below) --
// they already do their own `getAuthenticatedUser()` check and return a
// proper `401 { error: "unauthorized" }` JSON body (see
// app/api/chat/route.ts, app/api/sources/*); redirecting an API call to
// `/login` here would turn that into a broken HTML response instead.
//
// `app/auth/**` (the Google OAuth callback, `app/auth/callback/route.ts`)
// is excluded for a related but distinct reason: it's a Route Handler that
// legitimately runs with NO session cookie at all yet (the whole point is
// to exchange an OAuth `code` for the user's very first session) -- the
// `!user && !isPublicPath(pathname)` branch below would otherwise redirect
// every callback hit straight to `/login` before the code exchange ever
// runs, permanently breaking Google sign-in. That route validates its own
// redirect target against an allow-list itself (see its own header
// comment) -- it does not need this proxy's auth gate.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const PUBLIC_PATHS = ["/login"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function proxy(request: NextRequest) {
  // Mutated in-place by the `setAll` cookie adapter below so the final
  // response (redirect or pass-through) always carries any refreshed
  // session cookies -- see the `@supabase/ssr` Next.js middleware
  // reference implementation this follows.
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfigured environment -- fail open rather than redirect-looping
    // every request to a /login page that would itself also fail; the
    // route handlers' own getAuthenticatedUser() checks are the backstop.
    console.error("proxy: missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, skipping session refresh.");
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (not getSession()) -- revalidates against the auth server
  // rather than trusting a locally-decoded cookie, same rationale as
  // lib/supabase/server-client.ts's getAuthenticatedUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except: app/api/** and app/auth/** (both handle their own
    // auth -- see the module comment above), Next.js internals, and common
    // static asset extensions.
    "/((?!api/|auth/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
