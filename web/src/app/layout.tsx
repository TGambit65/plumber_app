import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Apex Plumbing — plumber_app", template: "%s · plumber_app" },
  description: "Field service platform for plumbing companies",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d4ed8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
