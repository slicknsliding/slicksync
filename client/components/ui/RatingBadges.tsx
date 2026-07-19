'use client';

interface RatingBadgesProps {
  imdbRating?: string | null;
  rottenTomatoes?: string | null;
  metacritic?: string | null;
  className?: string;
}

// Compact overlay row for poster cards (Dashboard's Continue Watching,
// Discover, Activity) - shows whichever of the three sources actually came
// back (OMDb doesn't have every rating for every title, and Rotten
// Tomatoes/Metacritic are gated behind OMDB_API_KEY being set at all).
// Renders nothing if none are available, so callers can drop this in
// unconditionally without an extra guard.
export function RatingBadges({ imdbRating, rottenTomatoes, metacritic, className = '' }: RatingBadgesProps) {
  if (!imdbRating && !rottenTomatoes && !metacritic) return null;

  return (
    <div className={`flex items-center gap-1 flex-wrap ${className}`}>
      {imdbRating && (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none"
          style={{ background: 'rgba(0,0,0,0.75)', color: '#f5c518' }}
          title="IMDb rating"
        >
          <span aria-hidden>★</span>
          {imdbRating}
        </span>
      )}
      {rottenTomatoes && (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none"
          style={{ background: 'rgba(0,0,0,0.75)', color: '#fa320a' }}
          title="Rotten Tomatoes"
        >
          <span aria-hidden>🍅</span>
          {rottenTomatoes}
        </span>
      )}
      {metacritic && (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none"
          style={{ background: 'rgba(0,0,0,0.75)', color: metacriticColor(metacritic) }}
          title="Metacritic score"
        >
          <span aria-hidden>Ⓜ</span>
          {metacritic}
        </span>
      )}
    </div>
  );
}

// Metacritic's own site color-codes by score band (green/yellow/red) - matching
// that convention here since a bare number alone doesn't read as "good" or
// "bad" the way IMDb's /10 and Rotten Tomatoes' % scales do at a glance.
export function metacriticColor(score: string): string {
  const n = parseInt(score, 10);
  if (Number.isNaN(n)) return '#e5e5e5';
  if (n >= 61) return '#6c3'; // green
  if (n >= 40) return '#fc3'; // yellow
  return '#f00'; // red
}
