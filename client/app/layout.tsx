import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";
import { ThemeProvider } from "@/lib/theme";
import { LayoutModeProvider } from "@/lib/layout-mode";
import { UserCacheProvider } from "@/components/providers/UserCacheProvider";

export const metadata: Metadata = {
  title: "SlickSync - Users, Groups & Addons",
  description: "SlickSync - Stremio & Nuvio Addon and User Management System",
  applicationName: "SlickSync",
  manifest: "/site.webmanifest",
  // iOS only exposes the Push API to web apps launched in STANDALONE mode from
  // the Home Screen (iOS 16.4+). `apple-mobile-web-app-capable: yes` is what
  // makes iOS open the Home Screen icon as a standalone app rather than a
  // Safari-chrome tab — without it, `PushManager` never appears and the toggle
  // reports "not supported" no matter how many times it's re-added.
  appleWebApp: {
    capable: true,
    title: "SlickSync",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: '/logo-black.png', media: '(prefers-color-scheme: light)' },
      { url: '/logo-white.png', media: '(prefers-color-scheme: dark)' },
    ],
    apple: [
      { url: '/logo-black.png', media: '(prefers-color-scheme: light)' },
      { url: '/logo-white.png', media: '(prefers-color-scheme: dark)' },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Outfit:wght@300..700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {/* The media detail modal's poster/background/cast images all come
            from these two CDNs - preconnecting warms up DNS/TLS ahead of the
            actual <img> requests instead of paying that setup cost right as
            the modal opens, which matters most on higher-latency mobile
            connections. */}
        <link rel="preconnect" href="https://images.metahub.space" />
        <link rel="preconnect" href="https://image.tmdb.org" />
      </head>
      <body
        className="antialiased aurora-scrollbar overflow-x-hidden bg-page"
        style={{
          color: 'var(--color-text)'
        }}
      >
        <div
          aria-hidden
          className="fixed inset-0 pointer-events-none z-0"
          style={{
            background:
              'radial-gradient(ellipse 800px 500px at 15% -10%, var(--color-primary-muted) 0%, transparent 60%),' +
              'radial-gradient(ellipse 700px 500px at 100% 10%, var(--color-secondary-muted) 0%, transparent 55%)',
          }}
        />
        <div className="relative z-10">
        <ThemeProvider>
          <LayoutModeProvider>
            <UserCacheProvider>
              <ToastProvider>
                {children}
              </ToastProvider>
            </UserCacheProvider>
          </LayoutModeProvider>
        </ThemeProvider>
        </div>
      </body>
    </html>
  );
}
