import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - My Library',
};

export default function UserLibraryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
