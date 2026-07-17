'use client';

import { createContext, useContext } from 'react';

interface UserMobileMenuContextType {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export const UserMobileMenuContext = createContext<UserMobileMenuContextType>({
  isOpen: false,
  onOpen: () => {},
  onClose: () => {},
});

export function useUserMobileMenu() {
  return useContext(UserMobileMenuContext);
}
