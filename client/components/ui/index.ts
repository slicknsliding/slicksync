import dynamic from 'next/dynamic';
export * from './Button';
export * from './CommandPalette';
export * from './Card';
export * from './Avatar';
export * from './UserAvatar';
export * from './Badge';
export * from './SlickSyncLogo';
export * from './SyncBadge';
export * from './ToggleSwitch';
export * from './ColorPicker';
export * from './DateTimePicker';
export * from './InlineEdit';
export * from './Modal';
// The title popup is ~1,900 lines that open on a click. Loading it after
// first paint instead of with it takes a real chunk out of every page's
// first load - it is by far the largest single thing in the shared bundle.
export const MediaDetailModal = dynamic(
  () => import('./MediaDetailModal').then((m) => m.MediaDetailModal),
  { ssr: false }
);
export * from './YearInReviewCard';
export * from './ListPosterThumb';
export * from './Input';
export * from './Skeleton';
export * from './Toast';
export * from './ContextMenu';
export * from './ViewModeToggle';
export * from './SelectAllCheckbox';
export * from './SelectionCheckbox';
export * from './FilterTabs';
export * from './PageToolbar';
export * from './DragSortable';
export * from './RatingBadges';
export * from './PosterCard';
export * from './VirtualPosterGrid';
export * from './ComboBox';
export * from './DropdownSelect';
export * from './BeginnerHint';
export * from './SyncPreviewDialog';
export * from './ProviderKeyHealthBadge';