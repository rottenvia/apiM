import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "API Manager",
  description:
    "A refined chat console for DeepSeek V4 — intelligent web search, thinking effort control, and a plugin system.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Stylesheet link rather than a CSS @import: the @import chained an
            extra round trip behind the stylesheet before the first text
            painted, which is the white flash when returning to a discarded
            tab. display=swap keeps text visible in the fallback face. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap"
        />
      </head>
      <body className="bg-bg-primary text-text-primary antialiased">
        {/*
          Startup splash. Server-rendered, so it paints with the first bytes —
          before the app's JavaScript has downloaded, hydrated, read settings
          and fetched the chat list, which is the blank wait after
          `npm run start`. The page adds .is-done once it is ready; a CSS
          timeout hides it regardless, so a failed script can never leave it
          covering the app.

          The bar is real progress, not a loop: CSS creeps it forward from the
          first paint (so it moves even while the scripts are still parsing),
          and src/components/startupSplash.ts then steps it through the actual
          milestones — app running, settings read, chat list in — before
          filling it and fading out. The status line under it is CSS content
          keyed on the same stage.
        */}
        <div id="app-splash" aria-hidden="true">
          <div className="app-splash-mark">
            <span />
            <span />
            <span />
          </div>
          <div className="app-splash-title">API Manager</div>
          <div className="app-splash-progress">
            <div className="app-splash-bar">
              <i className="app-splash-fill" />
            </div>
            <div className="app-splash-status" />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
