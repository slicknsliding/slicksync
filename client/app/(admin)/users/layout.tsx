import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Users',
};

export default function UsersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
