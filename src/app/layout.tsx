import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gulmohar Ground — First Person",
  description:
    "First-person gully football at golden hour. Grab up to nine friends, share a room code, and play 4v4 or 5v5 on a hand-painted Indian maidan.",
  keywords: ["football", "gully football", "multiplayer", "three.js", "first person", "browser game"],
  authors: [{ name: "Gulmohar Ground" }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f2ddbe",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Hand-drawn fonts for UI + canvas name tags (loaded via document.fonts).
            App Router: this layout wraps every route, so the link applies globally. */}
        { }
        {/* brush lettering for the EGO super cut-ins — subset to the glyphs we draw */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap&text=%20%21-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ%E2%80%94%E3%82%A8%E3%82%A9%E3%82%AA%E3%82%AB%E3%82%AC%E3%82%B4%E3%82%B7%E3%82%BF%E3%83%81%E3%83%83%E3%83%89%E3%83%90%E3%83%94%E3%83%A5%E3%83%AA%E3%83%B3%E5%85%A8%E5%88%BB%E5%A3%81%E5%B0%81%E5%B1%B1%E6%97%8B%E6%AD%A2%E7%88%AA%E7%B4%85%E9%96%8B%E9%9B%B7%E9%A2%A8%E9%B7%B2%E9%BE%8D" rel="stylesheet" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=Karla:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
