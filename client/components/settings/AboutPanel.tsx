'use client';

import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { Card } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';

const link = 'text-primary hover:underline';

const PEOPLE = [
  { name: 'iamneur0', href: 'https://github.com/iamneur0', what: <>created <a className={link} href="https://github.com/iamneur0/syncio" target="_blank" rel="noreferrer">Syncio</a>, the engine SlickSync is built on.</> },
  { name: 'Avangelista', href: 'https://github.com/Avangelista', what: <>the ideas behind signing in to Nuvio.</> },
  { name: 'Sonicx161', href: 'https://github.com/Sonicx161/AIOManager', what: <>created AIOManager, which inspired the Vault.</> },
  { name: '0xConstant1', href: 'https://github.com/0xConstant1', what: <>created LumiereDB.</> },
  { name: 'cedya77', href: 'https://github.com/cedya77/aiometadata', what: <>created AIOMetadata, whose LumiereDB guide this follows.</> },
];

/** Settings -> About: who SlickSync is built on, and where its data comes from. */
export function AboutPanel({ lumiere }: { lumiere: boolean }) {
  return (
    <PageSection className="mb-6">
      <Card padding="lg">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
            <InformationCircleIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-base font-semibold font-display text-default">About</h3>
            <p className="text-xs text-muted">The people and data SlickSync is built on.</p>
          </div>
        </div>

        <h4 className="text-sm font-semibold text-default mb-2">Credits</h4>
        <ul className="space-y-1.5 text-sm text-muted mb-5">
          {PEOPLE.map((p) => (
            <li key={p.name}>
              <a className={`${link} font-medium`} href={p.href} target="_blank" rel="noreferrer">{p.name}</a> - {p.what}
            </li>
          ))}
        </ul>

        <h4 className="text-sm font-semibold text-default mb-2">Data</h4>
        <ul className="space-y-1.5 text-sm text-muted">
          {lumiere && (
            <li>Information courtesy of IMDb (<a className={link} href="https://www.imdb.com" target="_blank" rel="noreferrer">https://www.imdb.com</a>). Used with permission.</li>
          )}
          <li>This product uses the TMDB API but is not endorsed or certified by TMDB.</li>
          <li>Titles and posters also come from Cinemeta and, with your own keys, OMDb, MDBList and RPDB.</li>
        </ul>
      </Card>
    </PageSection>
  );
}
