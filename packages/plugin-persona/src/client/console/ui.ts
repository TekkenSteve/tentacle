/**
 * Design tokens and the layout vocabulary for the expert console.
 *
 * Everything is expressed with the theme's `--dsw-*` aliases — the same tokens
 * `@deepseek-ai/dsh-client-ui-primitives` styles itself with — so the panel
 * inherits the official look in both light and dark themes without shipping a
 * stylesheet. Values the primitives already own (control heights, radii, status
 * colors) are never re-declared here.
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

/** Deterministic accent for experts that predate the template colour field. */
const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6'] as const

export function accentOf(id: string, color?: string): string {
  if (color !== undefined && color.trim() !== '') return color
  let hash = 0
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return ACCENTS[hash % ACCENTS.length]!
}

export const styles = {
  /**
   * Page column: 24px of air, a 1120px measure (the card grid needs more room
   * than the channels console's 960px reading width), 20px between blocks.
   */
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
  expertCard: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    height: 212,
    minWidth: 0,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    background: colors.layer1,
    overflow: 'hidden' as const,
    cursor: 'pointer',
  },
  cardBody: { display: 'flex', flexDirection: 'column' as const, gap: 0, padding: '14px 16px 10px', minWidth: 0, flex: 1 },
  cardHeaderNew: { display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', columnGap: 12, alignItems: 'center' as const, minWidth: 0 },
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
  division: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const, marginTop: 3, minWidth: 0 },
  divisionPill: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 20,
    padding: '0 7px',
    borderRadius: 4,
    border: `0.5px solid ${colors.border}`,
    background: colors.layer2,
    color: colors.secondary,
    fontSize: 11,
    lineHeight: '18px',
    whiteSpace: 'nowrap' as const,
  },
  cardActionsBar: { display: 'flex', alignItems: 'stretch', flexShrink: 0, borderTop: `1px solid ${colors.border}`, background: colors.layer2 },
  cardAction: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 34,
    padding: 0,
    border: 'none',
    borderLeft: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.secondary,
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  },
  card: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    minWidth: 0,
    padding: 14,
    paddingTop: 16,
    borderRadius: 12,
    border: `1px solid ${colors.border}`,
    background: colors.layer1,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
    cursor: 'pointer',
  },
  /** 2px accent strip along the card's top edge (the reference implementation's expert card cue). */
  accentBar: (accent: string) => ({
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    background: accent,
  }),
  cardHeader: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 },
  iconTile: (accent: string) => ({
    width: 40,
    height: 40,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: 20,
    lineHeight: 1,
    color: accent,
    background: `${accent}1a`,
  }),
  cardTitleBlock: { minWidth: 0, flex: 1, display: 'grid', gap: 3 },
  cardNameRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' as const },
  cardName: { fontWeight: 600 as const, fontSize: 14, lineHeight: '20px', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const },
  cardIdRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start' as const,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: colors.tertiary,
    fontSize: 11,
    lineHeight: '16px',
    fontFamily: colors.code,
    cursor: 'pointer',
    maxWidth: '100%',
    overflow: 'hidden' as const,
  },
  cardDesc: {
    margin: 0,
    fontSize: 12,
    lineHeight: '18px',
    color: colors.secondary,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden' as const,
    minHeight: 36,
  },
  meta: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 11, lineHeight: '16px', alignItems: 'baseline' as const },
  metaLabel: { color: colors.tertiary },
  metaValue: { color: colors.secondary, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, fontFamily: colors.code },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 'auto',
    paddingTop: 8,
    borderTop: `1px solid ${colors.border}`,
  },
  cardActions: { display: 'flex', alignItems: 'center', gap: 4 },

  empty: {
    display: 'grid',
    justifyItems: 'center' as const,
    gap: 8,
    padding: '36px 20px',
    border: `1px dashed ${colors.border}`,
    borderRadius: 12,
    textAlign: 'center' as const,
  },
  emptyTitle: { margin: 0, fontSize: 13, lineHeight: '18px', color: colors.text },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: colors.secondary },
  tiny: { fontSize: 11, lineHeight: '16px', color: colors.tertiary },

  /** Dialog body: section label + grouped fields. */
  form: { display: 'grid', gap: 14 },
  section: { display: 'grid', gap: 8 },
  sectionLabel: { margin: 0, fontSize: 12, fontWeight: 600 as const, color: colors.text },
  gridTwo: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 },
  field: { display: 'grid', gap: 4, minWidth: 0 },
  label: { fontSize: 12, lineHeight: '18px', color: colors.secondary },
  help: { fontSize: 11, lineHeight: '16px', color: colors.tertiary, margin: 0 },
  textarea: {
    padding: '7px 9px',
    borderRadius: 8,
    border: `${'0.5px'} solid ${colors.borderControl}`,
    background: 'transparent',
    color: colors.text,
    fontSize: 12,
    lineHeight: '18px',
    fontFamily: colors.code,
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box' as const,
    resize: 'vertical' as const,
  },
  codeBlock: {
    margin: 0,
    padding: 10,
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.layer2,
    color: colors.secondary,
    fontSize: 11,
    lineHeight: '17px',
    fontFamily: colors.code,
    maxHeight: 220,
    overflow: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  facts: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 12, lineHeight: '18px', alignItems: 'baseline' as const },
  factLabel: { color: colors.tertiary },
  factValue: { color: colors.text, minWidth: 0, wordBreak: 'break-all' as const },
  divider: { height: 1, background: colors.border, margin: '2px 0' },
  channelRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: colors.secondary },
  skillRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 0',
    borderTop: `1px solid ${colors.border}`,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '7px 10px',
    fontSize: 13,
    color: colors.text,
    background: colors.layer2,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    outline: 'none',
  },

  /** Table view (the card/table toggle's table half). */
  tableCard: { border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const, tableLayout: 'fixed' as const, fontSize: 12 },
  th: {
    textAlign: 'left' as const,
    padding: '8px 14px',
    fontSize: 11,
    fontWeight: 500 as const,
    color: colors.tertiary,
    borderBottom: `1px solid ${colors.border}`,
  },
  td: {
    padding: '9px 14px',
    borderTop: `1px solid ${colors.border}`,
    color: colors.text,
    verticalAlign: 'middle' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
} as const


/**
 * The primitives' Modal is a 380px card sized for short forms; the expert
 * detail/editor are long, scrollable documents. Inject two classes once (no
 * CSS build step in this package) and pass them through Modal's className /
 * contentClassName props.
 */
const STYLE_ID = 'tentacle-expert-console-style'

export function ensureConsoleStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.tentacle-expert-dialog{width:min(620px,100%);gap:0;}',
    '.tentacle-expert-content{max-height:calc(100vh - 140px);overflow-y:auto;}',
  ].join('\n')
  document.head.appendChild(style)
}
