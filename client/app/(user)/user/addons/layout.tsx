import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - My Addons',
};

export default function UserAddonsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
