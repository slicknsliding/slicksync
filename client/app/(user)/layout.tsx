'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { UserAuthProvider } from '@/lib/hooks/useUserAuth';
import { UserAuthGate } from '@/components/user/UserAuthGate';
import { UserSidebar } from '@/components/user/UserSidebar';
import { UserPageContainer } from '@/components/user/UserPageContainer';
import { UserMobileMenuContext } from '@/lib/hooks/useUserMobileMenu';

/**
 * User panel layout with sidebar navigation
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

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isMobileMenuOpen]);

  const handleOpen = () => setIsMobileMenuOpen(true);
  const handleClose = () => setIsMobileMenuOpen(false);

  return (
    <UserAuthProvider>
      <UserAuthGate>
        <UserMobileMenuContext.Provider value={{ isOpen: isMobileMenuOpen, onOpen: handleOpen, onClose: handleClose }}>
          <div className="relative min-h-screen">
            <UserSidebar isOpen={isMobileMenuOpen} onClose={handleClose} />
            <UserPageContainer>
              {children}
            </UserPageContainer>
          </div>
        </UserMobileMenuContext.Provider>
      </UserAuthGate>
    </UserAuthProvider>
  );
}
