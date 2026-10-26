// Chart tooltips are solid popups: opaque surface, the shared popup border
// and shadow, no blur. Colours are theme variables so every theme reads.
export const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-popup-border)',
  borderRadius: '12px',
  boxShadow: '0 20px 50px -14px rgba(0, 0, 0, 0.85), 0 3px 10px rgba(0, 0, 0, 0.45)',
} as const;

export const CHART_TOOLTIP_LABEL_STYLE = { color: 'var(--color-text)' } as const;
