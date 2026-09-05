'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Themes moved into Settings (it is a preference, and it was the only one
// living outside Settings). This route stays as a redirect so old links,
// bookmarks and the command palette's Themes entry keep working.
export default function ThemesPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/settings?tab=themes'); }, [router]);
  return null;
}
