// lib/ui/client-redirect.ts
//
// A session-expired (401) response from any app/api/** route means this
// tab's cookies are no longer valid -- every "use client" component that
// calls one of those routes (chat, sources upload/notion/url/google-drive/
// refresh/credentials) needs to bounce the user back to /login the same
// way. A *hard* navigation (not `useRouter().push()`) is intentional here,
// not an oversight: it forces a full request cycle through proxy.ts
// and drops all in-memory client state (in-flight streams, form drafts of
// secrets like a Notion token) rather than soft-navigating with a stale
// session still partially in memory.

export function redirectToLogin(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see module comment above.
  window.location.href = "/login";
}
