'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ComponentProps } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from './TVFocusable';

type NextLinkProps = ComponentProps<typeof Link>;

interface TVLinkProps extends NextLinkProps {
  /** Extra classes for TVFocusable's own wrapper div (TV mode only) - use
   *  this when the Link relies on being a direct flex/grid item with a
   *  specific size (w-full, h-full, flex-1, etc.), since TVFocusable adds
   *  one extra div between this Link and its parent on TV. */
  focusWrapperClassName?: string;
}

// Drop-in replacement for next/link's <Link> - D-pad focusable and scrolls
// into view on TV (reuses TVFocusable, not a reimplementation), a plain
// Link everywhere else. Extracted while wiring TV mode past Discover to the
// rest of the app - the "isTV ? <TVFocusable onEnterPress={...}><Link>...
// </Link></TVFocusable> : <Link>...</Link>" ternary was getting repeated at
// every single nav-link call site.
export function TVLink({ href, children, className, style, focusWrapperClassName, ...rest }: TVLinkProps) {
  const isTV = useIsTV();
  const router = useRouter();

  const link = (
    <Link href={href} tabIndex={isTV ? -1 : undefined} className={className} style={style} {...rest}>
      {children}
    </Link>
  );

  if (!isTV) return link;

  return (
    <TVFocusable
      className={focusWrapperClassName}
      onEnterPress={() => {
        if (typeof href === 'string') router.push(href);
        else if (href && typeof href === 'object' && 'pathname' in href && href.pathname) router.push(href.pathname);
      }}
    >
      {link}
    </TVFocusable>
  );
}
