/**
 * Design tokens and the shared layout vocabulary for the channels console.
 *
 * Everything here is expressed with the theme's `--dsw-*` aliases — the same
 * tokens `@deepseek-ai/dsh-client-ui-primitives` styles itself with — so the
 * page inherits the official look in both light and dark themes without
 * shipping its own stylesheet. Values the primitives already own (control
 * heights, control radii, status colors) are never re-declared here.
 */
export const colors = {
  text: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l3)',
  /** The stroke `Input` itself uses, so a native `select` sits beside it as a peer. */
  borderControl: 'var(--dsw-alias-border-l4)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  layer2: 'var(--dsw-alias-bg-layer-2)',
  accent: 'var(--dsw-alias-state-business-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

export const styles = {
  /**
   * The page column: 24px of air, a 960px reading measure left-aligned in the
   * panel (never stretched across an ultrawide window), 24px between blocks.
   */
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 24,
    padding: 24,
    maxWidth: 1120,
    boxSizing: 'border-box' as const,
    width: '100%',
    color: colors.text,
    fontSize: 13,
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  title: { margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600 as const, color: colors.text },
  pageHint: { margin: '4px 0 0', fontSize: 12, lineHeight: '18px', color: colors.secondary },
  stats: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const, marginTop: 8 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },

  sectionTitle: { margin: '0 0 8px', fontSize: 13, lineHeight: '20px', fontWeight: 500 as const, color: colors.secondary },
  /** Block content inside one section: 12px between the rows of a block. */
  stack: { display: 'grid', gap: 12 },
  /** One horizontal cluster of controls. */
  row: { display: 'flex', alignItems: 'center', gap: 8 },

  /** Hairline card: the instance list, the tables and the empty state share it. */
  card: { border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' as const },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: colors.secondary },
  tiny: { fontSize: 11, lineHeight: '16px', color: colors.tertiary },

  empty: {
    display: 'grid',
    justifyItems: 'center' as const,
    gap: 8,
    padding: '28px 20px',
    border: `1px dashed ${colors.border}`,
    borderRadius: 10,
    textAlign: 'center' as const,
  },

  /** Labelled form control: 12px label, control, 11px help. */
  field: { display: 'grid', gap: 4 },
  fieldLabel: { fontSize: 12, lineHeight: '18px', color: colors.secondary },
  fieldHelp: { fontSize: 11, lineHeight: '16px', color: colors.tertiary },
  /** Key/value rows of the read-only instance facts in the editor. */
  facts: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', alignItems: 'baseline' as const },
  factValue: { fontSize: 13, lineHeight: '20px', color: colors.text, fontFamily: colors.code, wordBreak: 'break-all' as const },

  table: { width: '100%', borderCollapse: 'collapse' as const, tableLayout: 'fixed' as const, fontSize: 12 },
  th: {
    textAlign: 'left' as const,
    padding: '8px 14px',
    fontSize: 11,
    fontWeight: 500 as const,
    color: colors.tertiary,
    borderBottom: `1px solid ${colors.border}`,
  },
  td: { padding: '8px 14px', borderTop: `1px solid ${colors.border}`, color: colors.text, verticalAlign: 'middle' as const },
  /** A machine identifier: monospace, one line, ellipsized — the full value
   * stays available through the cell's `title`. */
  codeCell: {
    fontFamily: colors.code,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },

  /** The native select the primitives do not cover, colored with the same
   * tokens as `Input`: 32px tall, `--dsw-radius-md`, layer-1 surface. */
  select: {
    height: 32,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '0 8px',
    border: `0.5px solid ${colors.borderControl}`,
    borderRadius: 'var(--dsw-radius-md)',
    background: colors.layer1,
    color: colors.text,
    fontSize: 14,
    lineHeight: '22px',
  },

  /** Destructive text on a ghost `Button` (the palette has no danger variant). */
  danger: { color: colors.danger },

  /** Platform catalog (the add-channel picker) and platform group headers. */
  platformGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
  platformCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    padding: '12px 14px',
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    background: colors.layer1,
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  platformIcon: {
    display: 'grid',
    placeItems: 'center' as const,
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 10,
    background: colors.layer2,
    fontSize: 18,
    lineHeight: 1,
  },
  platformHeader: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: colors.layer2, borderBottom: `1px solid ${colors.border}` },
  platformTitle: { fontSize: 13, fontWeight: 600 as const, color: colors.text },
  platformCount: { fontSize: 11, color: colors.tertiary },
  platformCardWrap: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
} as const


/**
 * The platform picker needs a two-column catalog wider than the primitives'
 * 380px dialog. Inject one class pair once (no CSS build step in this package).
 */
const STYLE_ID = 'tentacle-channels-console-style'

export function ensureConsoleStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.tentacle-platform-dialog{width:min(720px,100%);}',
    '.tentacle-platform-content{max-height:calc(100vh - 160px);overflow-y:auto;}',
    '.tentacle-channel-dialog{width:min(720px,100%);}',
    '.tentacle-channel-content{max-height:calc(100vh - 140px);overflow-y:auto;}',
  ].join('\n')
  document.head.appendChild(style)
}
