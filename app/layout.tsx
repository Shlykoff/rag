import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RAG Assistant",
  description: "AI assistant with retrieval-augmented generation over your documents.",
};

// Placeholder root layout from project bootstrap -- nextjs-frontend owns
// the real app shell/UI (see CLAUDE.md "Как организована работа
// агентов"). Uses a plain `{ children: React.ReactNode }` prop type rather
// than Next's generated `LayoutProps<"/">` helper, since the latter only
// exists after a `next build`/`next dev` typegen pass has run at least
// once (.next/types/routes.d.ts) -- avoiding that dependency keeps `tsc
// --noEmit` usable in CI/fresh checkouts before any build has happened.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
