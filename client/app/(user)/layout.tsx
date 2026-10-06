'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { UserAuthProvider } from '@/lib/hooks/useUserAuth';
import { UserAuthGate } from '@/components/user/UserAuthGate';
import { PersonTopbar } from '@/components/user/PersonTopbar';
import { UserPageContainer } from '@/components/user/UserPageContainer';
import { UserMobileMenuContext } from '@/lib/hooks/useUserMobileMenu';

/**
 * User panel layout: the same top bar as the admin pages (PersonTopbar)
 *
 * All user pages (home, library, activity, etc.) use this layout.
 * Requires Stremio OAuth authentication.
 */
export default function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const path = pathname || '/user';

    let section = 'Home';
    if (path.startsWith('/user/library')) section = 'Library';
    else if (path.startsWith('/user/activity')) section = 'Activity';
    else if (path.startsWith('/user/addons')) section = 'Addons';
    else if (path.startsWith('/user/shares')) section = 'Shares';
    else if (path.startsWith('/user/settings')) section = 'Settings';

    document.title = `SlickSync - ${section}`;
  }, [pathname]);

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  // globals.css gives the body overflow-x: hidden, which makes it the box a
  // sticky element measures against - and the top bar would scroll away with
  // the page. Unset while these pages are open, as AdminClientLayout does, so
  // the bar stays pinned.
  useEffect(() => {
    document.body.style.overflow = 'unset';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const handleOpen = () => setIsMobileMenuOpen(true);
  const handleClose = () => setIsMobileMenuOpen(false);

  return (
    <UserAuthProvider>
      <UserAuthGate>
        <UserMobileMenuContext.Provider value={{ isOpen: isMobileMenuOpen, onOpen: handleOpen, onClose: handleClose }}>
          <div className="relative min-h-screen">
            {/* The collapsed nav opens inside the bar, so nothing locks the page
                behind it the way the old side drawer did. */}
            <PersonTopbar />
            <UserPageContainer>
              {children}
            </UserPageContainer>
          </div>
        </UserMobileMenuContext.Provider>
      </UserAuthGate>
    </UserAuthProvider>
  );
}
