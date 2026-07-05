import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Vault',
};

export default function VaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
