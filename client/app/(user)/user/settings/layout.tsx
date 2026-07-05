import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - My Settings',
};

export default function UserSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
