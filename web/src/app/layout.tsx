import type { Metadata, Viewport } from "next";
// Self-hosted brand fonts (same-origin → cached by the service worker, works
// offline). Variable fonts; subsets are unicode-range gated so only latin is
// fetched for the English UI. Replaces the external Google Fonts CDN link.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/montserrat/index.css";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: { default: "Trade-Ops", template: "%s · Trade-Ops" },
  description: "Multi-tenant field-service operations platform for the trades",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Trade-Ops" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1E2430",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-screen bg-slate-100 font-sans text-slate-900 antialiased">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
