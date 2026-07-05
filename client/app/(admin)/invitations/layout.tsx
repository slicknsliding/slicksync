import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Invitations',
};

export default function InvitationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
