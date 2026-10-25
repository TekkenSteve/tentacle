/**
 * Rich report editor built on Tiptap + tiptap-markdown. Markdown remains the
 * persisted format (the preview, export and chart-token expansion all consume
 * it), while the editor provides formatting affordances and chart insertion.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import type { Translate } from '../locales.ts'
import type { ChartCard } from './api.ts'
import { colors, styles } from './ui.ts'

function ToolbarButton({ label, title, active, onClick }: {
  label: string
  title: string
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={{
        border: `1px solid ${active ? colors.accent : colors.border}`,
        background: active ? colors.hover : 'transparent',
        color: active ? colors.accent : colors.secondary,
        borderRadius: 5, fontSize: 11, lineHeight: '18px', padding: '0 6px', cursor: 'pointer',
      }}
    >{label}</button>
  )
}

export function ReportMarkdownEditor({ t, value, charts, onChange }: {
  t: Translate
  value: string
  charts: readonly ChartCard[]
  onChange: (markdown: string) => void
}): ReactElement {
  const [tick, setTick] = useState(0)
  const lastEmitted = useRef(value)
  const editor = useEditor({
    extensions: [StarterKit, Markdown.configure({ html: false, linkify: true, breaks: false })],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      const markdown = (current.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()
      lastEmitted.current = markdown
      onChange(markdown)
    },
    onTransaction: () => setTick((current) => current + 1),
  })

  useEffect(() => {
    if (editor === null) return
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    editor.commands.setContent(value)
  }, [editor, value])

  if (editor === null) return <div style={{ ...styles.textarea, minHeight: 360 }} />

  const chain = () => editor.chain().focus()
  const active = {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    h1: editor.isActive('heading', { level: 1 }),
    h2: editor.isActive('heading', { level: 2 }),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    quote: editor.isActive('blockquote'),
    code: editor.isActive('codeBlock'),
  }
  void tick
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <style>{`
        .tentacle-tiptap .ProseMirror { min-height: 340px; outline: none; font-size: 13px; line-height: 1.75; padding: 12px; }
        .tentacle-tiptap .ProseMirror h1 { font-size: 1.7em; margin: .5em 0 .35em; }
        .tentacle-tiptap .ProseMirror h2 { font-size: 1.35em; margin: .5em 0 .35em; }
        .tentacle-tiptap .ProseMirror h3 { font-size: 1.15em; margin: .5em 0 .35em; }
        .tentacle-tiptap .ProseMirror p { margin: .4em 0; }
        .tentacle-tiptap .ProseMirror ul, .tentacle-tiptap .ProseMirror ol { padding-left: 1.4em; margin: .4em 0; }
        .tentacle-tiptap .ProseMirror blockquote { border-left: 3px solid var(--dsw-alias-border-l3, #2c313c); margin: .5em 0; padding-left: .8em; color: var(--dsw-alias-label-secondary, #9aa1ad); }
        .tentacle-tiptap .ProseMirror pre { background: var(--dsw-alias-bg-layer-1, #151a22); border-radius: 6px; padding: 8px; overflow: auto; }
        .tentacle-tiptap .ProseMirror code { font-family: var(--dsw-alias-font-mono, monospace); font-size: .92em; }
        .tentacle-tiptap .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--dsw-alias-label-tertiary, #6b7280); float: left; height: 0; pointer-events: none; }
      `}</style>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <ToolbarButton label="B" title={t('data.report.bold')} active={active.bold} onClick={() => chain().toggleBold().run()} />
        <ToolbarButton label="I" title={t('data.report.italic')} active={active.italic} onClick={() => chain().toggleItalic().run()} />
        <ToolbarButton label="H1" title={t('data.report.heading1')} active={active.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()} />
        <ToolbarButton label="H2" title={t('data.report.heading2')} active={active.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
        <ToolbarButton label="•" title={t('data.report.bulletList')} active={active.bullet} onClick={() => chain().toggleBulletList().run()} />
        <ToolbarButton label="1." title={t('data.report.orderedList')} active={active.ordered} onClick={() => chain().toggleOrderedList().run()} />
        <ToolbarButton label="❝" title={t('data.report.quote')} active={active.quote} onClick={() => chain().toggleBlockquote().run()} />
        <ToolbarButton label="</>" title={t('data.report.codeBlock')} active={active.code} onClick={() => chain().toggleCodeBlock().run()} />
        {charts.length > 0 && (
          <select
            aria-label={t('data.report.insertChart')}
            value=""
            onChange={(event) => {
              const id = event.target.value
              if (id !== '') chain().insertContent(`{{chart:${id}}}`).run()
            }}
            style={{ ...styles.input, width: 'auto', maxWidth: 190, fontSize: 10, padding: '2px 4px' }}
          >
            <option value="">{t('data.report.insertChart')}</option>
            {charts.map((chart) => <option key={chart.id} value={chart.id}>{chart.title}</option>)}
          </select>
        )}
      </div>
      <div className="tentacle-tiptap" style={{ border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.layer1 }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
