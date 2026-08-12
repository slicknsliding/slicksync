import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SlickSync - Automation',
};

export default function AutomationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
