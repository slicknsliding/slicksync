import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Activity',
};

export default function ActivityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
