/**
 * The team management page, mounted as a global main panel next to the
 * experts and channels consoles (design 10 §6) — a team is a first-class
 * operational resource, not a preference.
 *
 * Two tabs: the deployment's team instances (card grid) and the bundled
 * template library. Every write goes through `/tentacle/api/admin/teams`.
 * The detail drawer loads the materialized skills lazily and degrades to
 * "no data" when the team workspace has none, so the page stays usable in a
 * teams-only deployment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  SegmentedTabs,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import {
  createTeam,
  errorText,
  listMemberOptions,
  listSkills,
  listTeams,
  listTemplates,
  refreshSkills,
  removeTeam,
  restoreTeam,
  text,
  updateTeam,
  type MemberOptionRow,
  type SkillRow,
  type TeamRow,
  type TemplateRow,
} from './api.ts'
import { TeamCard } from './team-card.tsx'
import {
  DeleteTeamDialog,
  TeamDetailDialog,
  TeamEditorDialog,
  draftOf,
  emptyDraft,
  writeOf,
  type TeamDraft,
} from './team-dialogs.tsx'
import { colors, ensureConsoleStyles, styles } from './ui.ts'

type Tab = 'instances' | 'library'

interface ToastMessage {
  readonly text: string
  readonly tone?: 'success'
  readonly seq: number
}

function matches(query: string, ...parts: Array<string | undefined>): boolean {
  if (query === '') return true
  return parts.some((part) => (part ?? '').toLowerCase().includes(query))
}

export function TeamsConsoleView({ t }: { t: Translate }): ReactElement {
  ensureConsoleStyles()
  const [teams, setTeams] = useState<readonly TeamRow[]>([])
  const [templates, setTemplates] = useState<readonly TemplateRow[]>([])
  const [options, setOptions] = useState<readonly MemberOptionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(undefined)
  const [tab, setTab] = useState<Tab>('instances')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<TeamRow | undefined>(undefined)
  const [detailSkills, setDetailSkills] = useState<readonly SkillRow[]>([])
  const [draft, setDraft] = useState<TeamDraft | undefined>(undefined)
  const [draftBuiltin, setDraftBuiltin] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TeamRow | undefined>(undefined)
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined)

  const onToast = useCallback((message: string, tone?: 'success') => {
    setToast((current) => ({ text: message, ...(tone === undefined ? {} : { tone }), seq: (current?.seq ?? 0) + 1 }))
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextTeams, nextTemplates, nextOptions] = await Promise.all([
        listTeams(),
        listTemplates(),
        listMemberOptions(),
      ])
      setTeams(nextTeams)
      setTemplates(nextTemplates)
      setOptions(nextOptions)
      setError(undefined)
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const openDetail = useCallback(async (team: TeamRow): Promise<void> => {
    setDetail(team)
    setDetailSkills([])
    try {
      setDetailSkills(await listSkills(team.id))
    } catch {
      setDetailSkills([])
    }
  }, [])

  const visible = useMemo(() => teams.filter((team) => matches(
    query,
    text(team.name),
    team.id,
    team.templateId,
    ...team.members.map((m) => `${m.expertId} ${m.expertName}`),
  )), [teams, query])

  const submitDraft = useCallback(async (): Promise<void> => {
    if (draft === undefined) return
    try {
      const saved = draft.id === undefined
        ? await createTeam(writeOf(draft))
        : await updateTeam({ ...writeOf(draft), id: draft.id })
      await reload()
      setDraft(undefined)
      onToast(t(draft.id === undefined ? 'teams.toast.created' : 'teams.toast.updated'), 'success')
      await openDetail(saved)
    } catch (caught) {
      onToast(errorText(t, caught))
    }
  }, [draft, reload, onToast, openDetail, t])

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (pendingDelete === undefined) return
    try {
      await removeTeam(pendingDelete.id)
      setPendingDelete(undefined)
      setDetail(undefined)
      await reload()
      onToast(t('teams.toast.removed'), 'success')
    } catch (caught) {
      onToast(errorText(t, caught))
    }
  }, [pendingDelete, reload, onToast, t])

  const restore = useCallback(async (team: TeamRow): Promise<void> => {
    try {
      const saved = await restoreTeam(team.id)
      await reload()
      await openDetail(saved)
      onToast(t('teams.toast.restored'), 'success')
    } catch (caught) {
      onToast(errorText(t, caught))
    }
  }, [reload, openDetail, onToast, t])

  const refresh = useCallback(async (team: TeamRow): Promise<void> => {
    try {
      await refreshSkills(team.id)
      setDetailSkills(await listSkills(team.id))
      onToast(t('teams.toast.skillsRefreshed'), 'success')
    } catch (caught) {
      onToast(errorText(t, caught))
    }
  }, [onToast, t])

  const cloneTemplate = useCallback(async (template: TemplateRow): Promise<void> => {
    try {
      const saved = await createTeam({ templateId: template.id })
      await reload()
      setTab('instances')
      onToast(t('teams.toast.created'), 'success')
      await openDetail(saved)
    } catch (caught) {
      onToast(errorText(t, caught))
    }
  }, [reload, onToast, openDetail, t])

  const builtinCount = teams.filter((team) => team.builtin).length
  const memberTotal = teams.reduce((sum, team) => sum + team.members.length, 0)

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('teams.panel')}</h2>
          <p style={styles.pageHint}>{t('teams.panel.hint')}</p>
          <div style={styles.stats}>
            <span style={styles.chip}>{t('teams.stats.total')} {teams.length}</span>
            <span style={styles.chip}>{t('teams.stats.builtin')} {builtinCount}</span>
            <span style={styles.chip}>{t('teams.stats.custom')} {teams.length - builtinCount}</span>
            <span style={styles.chip}>{t('teams.stats.members')} {memberTotal}</span>
          </div>
        </div>
        <div style={styles.actions}>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            <IconRefreshOutlineRegular size={14} />
            {t('teams.action.refresh')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => { setDraftBuiltin(false); setDraft(emptyDraft()) }}
          >
            <IconPlusOutlineRegular size={14} />
            {t('teams.action.create')}
          </Button>
        </div>
      </header>

      <div style={styles.toolbar}>
        <SegmentedTabs<Tab>
          label={t('teams.panel')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'instances', label: t('teams.tab.instances'), id: 'tentacle-teams-tab-instances', panelId: 'tentacle-teams-panel-instances' },
            { value: 'library', label: t('teams.tab.library'), id: 'tentacle-teams-tab-library', panelId: 'tentacle-teams-panel-library' },
          ]}
        />
        {tab === 'instances' ? (
          <div style={styles.search}>
            <Input
              value={query}
              icon={<IconSearchOutlineRegular size={14} />}
              placeholder={t('teams.search.placeholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {error !== undefined ? (
        <div style={{ fontSize: 12, color: colors.danger }}>{errorText(t, error)}</div>
      ) : null}

      {tab === 'instances' ? (
        loading && teams.length === 0 ? (
          <div style={{ fontSize: 12, color: colors.secondary }}>{t('teams.action.refresh')}…</div>
        ) : visible.length === 0 ? (
          <div style={styles.empty}>
            <strong style={{ fontSize: 13 }}>{query === '' ? t('teams.empty.title') : t('teams.empty.search')}</strong>
            {query === '' ? <span style={{ fontSize: 12 }}>{t('teams.empty.hint')}</span> : null}
          </div>
        ) : (
          <div style={styles.grid}>
            {visible.map((team) => (
              <TeamCard key={team.id} team={team} t={t} onOpen={(next) => void openDetail(next)} />
            ))}
          </div>
        )
      ) : (
        templates.length === 0 ? (
          <div style={styles.empty}>
            <strong style={{ fontSize: 13 }}>{t('teams.library.empty')}</strong>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={styles.sectionHint}>{t('teams.library.hint')}</p>
            <div style={styles.grid}>
              {templates.map((template) => (
                <div key={template.id} style={{ ...styles.teamCard, cursor: 'default', height: 'auto' }}>
                  <div style={styles.cardBody}>
                    <div style={styles.cardHeader}>
                      <div style={{ ...styles.avatar, background: `${colors.accent}1f`, color: colors.accent }}>
                        {template.icon ?? '👥'}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{text(template.label)}</span>
                          <span style={styles.divisionPill}>{t('teams.badge.template')}</span>
                        </div>
                        <div style={{ fontSize: 12, color: colors.secondary, marginTop: 2 }}>{text(template.description)}</div>
                      </div>
                    </div>
                    <div style={{ ...styles.division, marginTop: 10 }}>
                      {template.members.map((member) => (
                        <span key={member.expertId} style={styles.chip} title={text(member.role)}>
                          {member.expertName} · {text(member.role)}
                        </span>
                      ))}
                    </div>
                    <div style={{ ...styles.division, marginTop: 8, fontSize: 11, color: colors.tertiary }}>
                      {fmtCount(t, template.quickPrompts.length)}
                    </div>
                  </div>
                  <div style={styles.cardFooter}>
                    <span style={styles.mono}>{template.id}</span>
                    <Button size="sm" variant="outline" onClick={() => void cloneTemplate(template)}>
                      {t('teams.action.clone')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {detail !== undefined ? (
        <TeamDetailDialog
          team={detail}
          skills={detailSkills}
          t={t}
          onClose={() => setDetail(undefined)}
          onEdit={() => { setDraftBuiltin(detail.builtin); setDraft(draftOf(detail)) }}
          onDelete={() => setPendingDelete(detail)}
          onRestore={() => void restore(detail)}
          onRefreshSkills={() => void refresh(detail)}
        />
      ) : null}

      {draft !== undefined ? (
        <TeamEditorDialog
          draft={draft}
          options={options}
          builtin={draftBuiltin}
          t={t}
          onChange={setDraft}
          onSubmit={() => void submitDraft()}
          onClose={() => setDraft(undefined)}
        />
      ) : null}

      {pendingDelete !== undefined ? (
        <DeleteTeamDialog
          team={pendingDelete}
          t={t}
          onConfirm={() => void confirmDelete()}
          onClose={() => setPendingDelete(undefined)}
        />
      ) : null}

      {toast !== undefined ? (
        <Toast
          key={toast.seq}
          text={toast.text}
          {...(toast.tone === undefined ? {} : { tone: toast.tone })}
          onDone={() => setToast(undefined)}
        />
      ) : null}
    </div>
  )
}

/** "{n} quick prompts" with the count interpolated. */
function fmtCount(t: Translate, count: number): string {
  return t('teams.library.quickPrompts').replace('{n}', String(count))
}
