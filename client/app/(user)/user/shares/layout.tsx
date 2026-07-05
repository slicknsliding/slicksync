import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - My Shares',
};

export default function UserSharesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
