import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Settings',
};

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
