import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - My Activity',
};

export default function UserActivityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
