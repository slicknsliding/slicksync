import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Addons',
};

export default function AddonsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
