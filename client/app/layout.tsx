import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";
import { ThemeProvider } from "@/lib/theme";
import { LayoutModeProvider } from "@/lib/layout-mode";
import { UserCacheProvider } from "@/components/providers/UserCacheProvider";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { BuildWatcher } from "@/components/pwa/BuildWatcher";
import { ScrollToTopOnNavigate } from "@/components/layout/ScrollToTopOnNavigate";

export const metadata: Metadata = {
  title: "SlickSync - Users, Groups & Addons",
  description: "SlickSync - Nuvio & Stremio Addon and User Management System",
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
    // iOS reads exactly one apple-touch-icon and ignores media queries on
    // it, so this is the purpose-made 180px icon rather than the wordmark.
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

// viewport-fit=cover is what lets the page extend under the notch and the
// home indicator on an iPhone; the safe-area padding in globals.css is what
// keeps the actual UI out from under them. Without the first, a Home Screen
// install with a translucent status bar drew the top bar behind the clock.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The default (Nebula) background; lib/theme.tsx moves it to the active
  // theme's background once the page starts.
  themeColor: '#0d1117',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // data-scroll-behavior lets Next.js turn the smooth scrolling in
  // globals.css off while it changes page; without it the jump to the top of
  // a new page was animated and cut short, landing partway down.
  return (
    <html lang="en" className="dark" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Space Grotesk (headings) + Outfit (body) power the default UI
            type. They are self-hosted under /fonts and declared in
            globals.css - see the note there - so no request leaves this
            origin before first paint. */}
        <link rel="preload" href="/fonts/outfit-latin-v15.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/space-grotesk-latin-v22.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* The other 10 families are Build-your-own-theme choices (Settings
            -> Themes). Their stylesheet is no longer requested here: most
            page loads never use one, so lib/theme.tsx (loadOptionalFonts)
            adds it only when the active custom theme picks one of them, and
            Settings -> Themes adds it when it opens. */}
        {/* The media detail modal's poster/background/cast images all come
            from these two CDNs - preconnecting warms up DNS/TLS ahead of the
            actual <img> requests instead of paying that setup cost right as
            the modal opens, which matters most on higher-latency mobile
            connections. */}
        <link rel="preconnect" href="https://images.metahub.space" />
        <link rel="preconnect" href="https://image.tmdb.org" />
        {/* iOS runs a Home Screen-launched web app (standalone display mode -
            see appleWebApp.capable above) in a separate WKWebView process
            with markedly worse backdrop-filter/blur compositing than the
            exact same page in a normal Safari tab - a known WebKit
            regression, not anything specific to this app's CSS. This app
            leans on blur heavily (nav bar, modals, dropdowns, cards), so
            that shows up as real jank opening/closing modals specifically
            when launched from the Home Screen icon, confirmed by direct
            user report (fast in Safari, slow from the Home Screen bookmark
            for the identical page). Sets data-standalone on <html> before
            first paint (blocking inline script, not a useEffect, so there's
            no flash of blurred-then-unblurred UI) - see globals.css for the
            actual blur kill-switch this attribute gates. navigator.standalone
            is iOS Safari's own flag; matchMedia covers Android/desktop PWA
            installs the same way. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(window.navigator.standalone===true||window.matchMedia('(display-mode: standalone)').matches){document.documentElement.setAttribute('data-standalone','true')}}catch(e){}`,
          }}
        />
        {/* The saved theme, before first paint - the same blocking-script
            pattern as above. Without it every page opened in the default
            colours and switched once the app started (a light theme flashed
            dark first). A built-in theme is its class; a custom one starts
            from its base theme here, and its own colours follow at start-up
            (lib/theme.tsx). The id list mirrors themeIds there. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('slicksync-theme'),b=['nebula','slick','velvet','midnight','ember','nord','verdant','slate','rose','daylight'];if(t&&b.indexOf(t)<0){var c=JSON.parse(localStorage.getItem('slicksync-custom-themes')||'[]').filter(function(x){return x&&x.id===t})[0];t=c&&c.base}if(t&&b.indexOf(t)>=0)document.documentElement.className=t}catch(e){}`,
          }}
        />
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
                <ServiceWorkerRegistrar />
                <BuildWatcher />
                <ScrollToTopOnNavigate />
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
