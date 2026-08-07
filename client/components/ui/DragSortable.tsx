'use client';

import { ReactNode, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import { useVaultDrag } from '@/components/providers/VaultDragContext';

export {
  useSortable,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

export { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core';
export { CSS } from '@dnd-kit/utilities';

export function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    // delay:0/distance:0 meant a drag engaged on the very first touchmove
    // event, with nothing to tell it apart from the start of a vertical
    // scroll swipe - on a phone, that made reordering (Addons grid, Vault
    // categories) grab the card instead of scrolling the page almost every
    // time. A short delay is dnd-kit's own documented fix for exactly this
    // tension (see their docs on touch vs scroll): a deliberate press-and-
    // hold engages the drag, a normal swipe (which moves immediately, not
    // held still) passes through to native scroll untouched. tolerance
    // allows a little finger drift during the hold before it's cancelled as
    // an accidental touch.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
}

export function useSortableDragState(id: string) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 100 : undefined,
    isolation: 'isolate',
  };

  const dragHandleProps = {
    ...attributes,
    ...listeners,
    style: { touchAction: 'none' } as React.CSSProperties,
    className: 'cursor-grab active:cursor-grabbing p-1 rounded hover:bg-surface-hover',
  };

  return {
    dragHandleProps,
    itemProps: {
      ref: setNodeRef,
      style,
      className: isDragging ? 'shadow-lg ring-2 ring-primary' : '',
    },
    isDragging,
  };
}

interface SortableItemRenderProps {
  id: string;
  dragHandleProps: Record<string, unknown>;
  itemProps: {
    ref: React.RefCallback<HTMLElement>;
    style: React.CSSProperties;
    className: string;
  };
  isDragging: boolean;
}

interface DraggableListProps {
  items: string[];
  renderItem: (props: SortableItemRenderProps) => ReactNode;
  onDragEnd?: (event: DragEndEvent) => void;
}

function SortableItem({
  id,
  renderItem,
}: {
  id: string;
  renderItem: (props: SortableItemRenderProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 100 : undefined,
    opacity: isDragging ? 0 : 1,
  };

  const dragHandleProps = {
    ...attributes,
    ...listeners,
    style: { touchAction: 'none' } as React.CSSProperties,
    className: 'cursor-grab active:cursor-grabbing p-1 rounded hover:bg-surface-hover',
  };

  const itemProps = {
    ref: setNodeRef,
    style,
    className: isDragging ? 'shadow-lg ring-2 ring-primary' : '',
  };

  return renderItem({ id, dragHandleProps, itemProps, isDragging });
}

// Registers with the shared layout-level DndContext (AdminClientLayout)
// instead of creating its own nested DndContext - every caller of
// DraggableList already lives inside the admin layout, which already wraps
// everything in its own DndContext for Vault/Addons/Users/Groups reordering.
// Nesting a second DndContext here meant BOTH sets of sensors listened to
// the same pointer events for the same drag gesture, which produced real,
// confirmed (via screenshot) bugs - items overlapping, drag state getting
// stuck mid-reorder. No local DragOverlay either, for the same reason
// (it needs its own DndContext ancestor) - falls back to the same in-place
// transform animation Addons/Users/Groups' own reorder already uses
// successfully with no overlay.
export function DraggableList({
  items,
  renderItem,
  onDragEnd,
}: DraggableListProps) {
  const { registerDragEndHandler } = useVaultDrag();

  useEffect(() => {
    if (!onDragEnd) return;
    return registerDragEndHandler(onDragEnd);
  }, [onDragEnd, registerDragEndHandler]);

  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      <div className="space-y-3" style={{ touchAction: 'none', userSelect: 'none' }}>
        {items.map((id) => (
          <SortableItem key={id} id={id} renderItem={renderItem} />
        ))}
      </div>
    </SortableContext>
  );
}
