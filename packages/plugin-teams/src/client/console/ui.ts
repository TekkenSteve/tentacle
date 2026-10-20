/**
 * Design tokens and the layout vocabulary for the team console.
 *
 * Everything is expressed with the theme's `--dsw-*` aliases — the same
 * tokens `@deepseek-ai/dsh-client-ui-primitives` styles itself with — so the
 * panel inherits the official look in both light and dark themes without
 * shipping a stylesheet. Values the primitives already own (control heights,
 * radii, status colors) are never re-declared here.
 */
export const colors = {
  text: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l3)',
  borderControl: 'var(--dsw-alias-border-l4)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  layer2: 'var(--dsw-alias-bg-layer-2)',
  accent: 'var(--dsw-alias-state-business-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

/** Deterministic accent for teams that predate the template colour field. */
const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6'] as const

export function accentOf(id: string, color?: string): string {
  if (color !== undefined && color.trim() !== '') return color
  let hash = 0
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return ACCENTS[hash % ACCENTS.length]!
}

export const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 20,
    padding: 24,
    maxWidth: 1120,
    boxSizing: 'border-box' as const,
    width: '100%',
    color: colors.text,
    fontSize: 13,
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' as const },
  title: { margin: 0, fontSize: 17, lineHeight: '24px', fontWeight: 600 as const, color: colors.text },
  pageHint: { margin: '4px 0 0', fontSize: 12, lineHeight: '18px', color: colors.secondary, maxWidth: 640 },
  stats: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const, marginTop: 10 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },

  toolbar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const },
  search: { flex: '1 1 240px', minWidth: 200, maxWidth: 360 },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
    gap: 12,
  },
  teamCard: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    height: 224,
    minWidth: 0,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    background: colors.layer1,
    overflow: 'hidden' as const,
    cursor: 'pointer',
  },
  cardBody: { display: 'flex', flexDirection: 'column' as const, gap: 0, padding: '14px 16px 10px', minWidth: 0, flex: 1 },
  cardHeader: { display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', columnGap: 12, alignItems: 'center' as const, minWidth: 0 },
  avatar: {
    display: 'grid',
    placeItems: 'center' as const,
    width: 44,
    height: 44,
    borderRadius: 'var(--dsw-radius-md, 12px)',
    background: colors.layer2,
    fontSize: 22,
    lineHeight: 1,
  },
  /** Overlapping member chips — the roster at a glance. */
  avatarStack: { display: 'flex', alignItems: 'center' as const },
  avatarStackItem: {
    display: 'grid',
    placeItems: 'center' as const,
    width: 26,
    height: 26,
    borderRadius: 999,
    border: `2px solid ${colors.layer1}`,
    background: colors.layer2,
    fontSize: 11,
    fontWeight: 600 as const,
    color: colors.secondary,
    marginLeft: -8,
  },
  avatarStackFirst: { marginLeft: 0 },
  division: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const, marginTop: 3, minWidth: 0 },
  divisionPill: {
    display: 'inline-flex',
    alignItems: 'center' as const,
    gap: 4,
    maxWidth: '100%',
    padding: '1px 8px',
    borderRadius: 999,
    border: `1px solid ${colors.border}`,
    background: colors.layer2,
    fontSize: 11,
    lineHeight: '18px',
    color: colors.secondary,
  },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 16px',
    borderTop: `1px solid ${colors.border}`,
    background: colors.layer2,
    fontSize: 11,
    color: colors.tertiary,
  },

  section: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: colors.text },
  sectionHint: { margin: 0, fontSize: 12, lineHeight: '18px', color: colors.secondary },

  /** Key/value rows inside the detail drawer. */
  detailRow: { display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 12, alignItems: 'start' as const, padding: '6px 0' },
  detailKey: { fontSize: 12, color: colors.secondary, lineHeight: '20px' },
  detailValue: { fontSize: 12, color: colors.text, lineHeight: '20px', minWidth: 0, wordBreak: 'break-all' as const },
  mono: { fontFamily: colors.code, fontSize: 11 },

  memberRow: { display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: 10, alignItems: 'start' as const },
  memberRole: { fontSize: 12, color: colors.secondary, lineHeight: '18px', marginTop: 2, minWidth: 0, overflowWrap: 'anywhere' as const },
  memberIndex: {
    display: 'grid',
    placeItems: 'center' as const,
    width: 24,
    height: 24,
    borderRadius: 999,
    background: colors.layer2,
    fontSize: 11,
    fontWeight: 600 as const,
    color: colors.secondary,
  },

  field: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600 as const, color: colors.text },
  fieldHint: { fontSize: 11, color: colors.tertiary, lineHeight: '16px' },
  textarea: {
    width: '100%',
    boxSizing: 'border-box' as const,
    minHeight: 64,
    padding: '6px 10px',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    border: `1px solid ${colors.borderControl}`,
    background: colors.layer1,
    color: colors.text,
    fontSize: 12,
    lineHeight: '18px',
    resize: 'vertical' as const,
    fontFamily: 'inherit',
  },

  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    padding: '48px 24px',
    border: `1px dashed ${colors.border}`,
    borderRadius: 12,
    color: colors.secondary,
    textAlign: 'center' as const,
  },

  chips: { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center' as const,
    gap: 4,
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid ${colors.border}`,
    background: colors.layer2,
    fontSize: 11,
    color: colors.secondary,
  },
  skillItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    padding: '8px 10px',
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    background: colors.layer2,
  },
} as const

/** The primitives' Modal is a 380px card sized for short forms; the team
 * detail and editor are long, wide documents. Inject the two classes once (no
 * CSS build step in this package) and pass them through Modal's className /
 * contentClassName props — the same split the experts console uses. */
const STYLE_ID = 'tentacle-teams-console-style'

export function ensureConsoleStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.tentacle-team-dialog{width:min(720px,100%);gap:0;}',
    '.tentacle-team-content{max-height:calc(100vh - 140px);overflow-y:auto;}',
  ].join('\n')
  document.head.appendChild(style)
}
