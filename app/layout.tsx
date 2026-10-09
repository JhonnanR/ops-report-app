import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ops Report",
  description: "Report construction progress by elevation",
  applicationName: "Ops Report",
  appleWebApp: {
    capable: true,
    title: "Ops Report",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false, // fixed view on phones: no pinch/auto zoom
  themeColor: "#1f3a5f",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}