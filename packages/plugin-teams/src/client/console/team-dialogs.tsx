/**
 * Team dialogs: the detail drawer (overview / members / contract /
 * workspace / preset / materialized skills), the editor (roster 2–8,
 * contract, collaboration, advanced routing) and the delete confirmation.
 *
 * Built-in teams keep a fixed identity (name/icon/description) — the editor
 * disables those fields and offers restore-from-template instead (10 §10).
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import { fmt } from '../locales.ts'
import { text, type MemberOptionRow, type SkillRow, type TeamRow, type TeamWrite } from './api.ts'
import { accentOf, colors, styles } from './ui.ts'

/** Draft state of the editor: plain strings until the host normalizes them. */
export interface TeamDraft {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly icon: string
  readonly color: string
  readonly members: readonly { readonly expertId: string; readonly role: string }[]
  readonly goal: string
  readonly constraints: string
  readonly delivery: string
  readonly examples: string
  readonly collaboration: 'dispatch' | 'auto'
  readonly modelProvider: string
  readonly modelName: string
  readonly permissionPreset: string
}

export function draftOf(team: TeamRow): TeamDraft {
  return {
    id: team.id,
    name: team.name.zh,
    description: team.description.zh,
    icon: team.icon ?? '',
    color: team.color ?? '',
    members: team.members.map((m) => ({ expertId: m.expertId, role: m.role.zh })),
    goal: team.contract.goal?.zh ?? '',
    constraints: team.contract.constraints.map((c) => c.zh).join('\n'),
    delivery: team.contract.delivery?.zh ?? '',
    examples: team.contract.examples.map((c) => c.zh).join('\n'),
    collaboration: team.collaboration,
    modelProvider: team.model?.provider ?? '',
    modelName: team.model?.model ?? '',
    permissionPreset: team.permissionPreset ?? '',
  }
}

export function emptyDraft(): TeamDraft {
  return {
    name: '',
    description: '',
    icon: '',
    color: '',
    members: [],
    goal: '',
    constraints: '',
    delivery: '',
    examples: '',
    collaboration: 'dispatch',
    modelProvider: '',
    modelName: '',
    permissionPreset: '',
  }
}

/** Split a textarea into non-empty lines (the host applies the bounds). */
function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** The write payload one draft produces. */
export function writeOf(draft: TeamDraft): TeamWrite {
  const modelProvider = draft.modelProvider.trim()
  const modelName = draft.modelName.trim()
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    description: draft.description.trim(),
    ...(draft.icon.trim() === '' ? {} : { icon: draft.icon.trim() }),
    ...(draft.color.trim() === '' ? {} : { color: draft.color.trim() }),
    members: draft.members.map((m) => ({ expertId: m.expertId, role: m.role.trim() })),
    contract: {
      ...(draft.goal.trim() === '' ? {} : { goal: draft.goal.trim() }),
      constraints: lines(draft.constraints),
      ...(draft.delivery.trim() === '' ? {} : { delivery: draft.delivery.trim() }),
      examples: lines(draft.examples),
    },
    collaboration: draft.collaboration,
    model: modelProvider !== '' && modelName !== '' ? { provider: modelProvider, model: modelName } : null,
    permissionPreset: draft.permissionPreset.trim() === '' ? null : draft.permissionPreset.trim(),
  }
}

/** Detail drawer: everything a team is, read-mostly with the write actions. */
export function TeamDetailDialog({ team, skills, t, onClose, onEdit, onDelete, onRestore, onRefreshSkills }: {
  team: TeamRow
  skills: readonly SkillRow[]
  t: Translate
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onRestore: () => void
  onRefreshSkills: () => void
}): ReactElement {
  const contract = team.contract
  return (
    <Modal
      open
      onClose={onClose}
      title={t('teams.detail.title')}
      closeLabel={t('teams.action.close')}
      className="tentacle-team-dialog"
      contentClassName="tentacle-team-content"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%', minWidth: 0 }}>
        <section style={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ ...styles.avatar, background: `${accentOf(team.id, team.color)}1f`, color: accentOf(team.id, team.color) }}>
              {team.icon ?? '👥'}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{text(team.name)}</span>
                {team.builtin ? <Tag tone="neutral">{t('teams.badge.builtin')}</Tag> : <Tag tone="neutral">{t('teams.badge.custom')}</Tag>}
                <Tag tone="neutral">{team.collaboration === 'auto' ? t('teams.badge.auto') : t('teams.badge.dispatch')}</Tag>
              </div>
              <div style={{ fontSize: 12, color: colors.secondary, marginTop: 2 }}>{text(team.description)}</div>
            </div>
          </div>
        </section>

        <section style={styles.section}>
          <h4 style={styles.sectionTitle}>{t('teams.detail.members')}</h4>
          <p style={styles.sectionHint}>{t('teams.detail.membersHint')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {team.members.map((member, index) => (
              <div key={member.expertId} style={styles.memberRow}>
                <div style={styles.memberIndex}>{index + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{member.expertName}</div>
                  <div style={{ ...styles.mono, color: colors.tertiary }}>{member.expertId}</div>
                  <div style={styles.memberRole}>{text(member.role)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={styles.section}>
          <h4 style={styles.sectionTitle}>{t('teams.detail.contract')}</h4>
          <p style={styles.sectionHint}>{t('teams.detail.contractHint')}</p>
          {contract.goal !== undefined ? (
            <div style={styles.detailRow}>
              <div style={styles.detailKey}>{t('teams.detail.goal')}</div>
              <div style={styles.detailValue}>{text(contract.goal)}</div>
            </div>
          ) : null}
          {contract.constraints.length > 0 ? (
            <div style={styles.detailRow}>
              <div style={styles.detailKey}>{t('teams.detail.constraints')}</div>
              <div style={{ ...styles.detailValue, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {contract.constraints.map((item, index) => <span key={index}>· {text(item)}</span>)}
              </div>
            </div>
          ) : null}
          {contract.delivery !== undefined ? (
            <div style={styles.detailRow}>
              <div style={styles.detailKey}>{t('teams.detail.delivery')}</div>
              <div style={styles.detailValue}>{text(contract.delivery)}</div>
            </div>
          ) : null}
          {contract.examples.length > 0 ? (
            <div style={styles.detailRow}>
              <div style={styles.detailKey}>{t('teams.detail.examples')}</div>
              <div style={{ ...styles.detailValue, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {contract.examples.map((item, index) => <span key={index}>· {text(item)}</span>)}
              </div>
            </div>
          ) : null}
        </section>

        <section style={styles.section}>
          <h4 style={styles.sectionTitle}>{t('teams.detail.routing')}</h4>
          <div style={styles.detailRow}>
            <div style={styles.detailKey}>{t('teams.detail.preset')}</div>
            <div style={styles.detailValue}>
              <span style={styles.mono}>{team.presetId}</span>
              <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 2 }}>{t('teams.detail.presetHint')}</div>
            </div>
          </div>
          <div style={styles.detailRow}>
            <div style={styles.detailKey}>{t('teams.detail.workspace')}</div>
            <div style={styles.detailValue}>
              <span style={styles.mono}>{team.workspacePath}</span>
              <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 2 }}>{t('teams.detail.workspaceHint')}</div>
            </div>
          </div>
          <div style={styles.detailRow}>
            <div style={styles.detailKey}>{t('teams.card.model')}</div>
            <div style={styles.detailValue}>
              {team.model === undefined ? t('teams.editor.default') : `${team.model.provider} / ${team.model.model}`}
            </div>
          </div>
          <div style={styles.detailRow}>
            <div style={styles.detailKey}>{t('teams.card.permission')}</div>
            <div style={styles.detailValue}>{team.permissionPreset ?? t('teams.editor.default')}</div>
          </div>
        </section>

        <section style={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <h4 style={styles.sectionTitle}>{t('teams.detail.skills')}</h4>
            <Button size="sm" variant="ghost" onClick={onRefreshSkills}>
              <IconRefreshOutlineRegular size={14} />
              {t('teams.action.refreshSkills')}
            </Button>
          </div>
          <p style={styles.sectionHint}>{t('teams.detail.skillsHint')}</p>
          {skills.length === 0 ? (
            <div style={{ fontSize: 12, color: colors.tertiary }}>{t('teams.detail.skillsEmpty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {skills.map((skill) => (
                <div key={skill.path} style={styles.skillItem}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{skill.name}</div>
                  <div style={styles.mono}>{skill.path}</div>
                  {skill.description !== '' ? (
                    <div style={{ fontSize: 11, color: colors.secondary }}>{skill.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={onEdit}>{t('teams.action.edit')}</Button>
          {team.builtin ? <Button variant="outline" onClick={onRestore}>{t('teams.action.restore')}</Button> : null}
          {team.builtin ? null : (
            <Button variant="ghost" onClick={onDelete}>
              <IconTrashOutlineRegular size={14} />
              {t('teams.action.delete')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Editor: roster picker (2–8) + contract + collaboration + advanced routing. */
export function TeamEditorDialog({ draft, options, builtin, t, onChange, onSubmit, onClose }: {
  draft: TeamDraft
  options: readonly MemberOptionRow[]
  /** Built-in teams keep a fixed identity (10 §10). */
  builtin: boolean
  t: Translate
  onChange: (draft: TeamDraft) => void
  onSubmit: () => void
  onClose: () => void
}): ReactElement {
  const [pick, setPick] = useState('')
  const used = new Set(draft.members.map((m) => m.expertId))
  const available = options.filter((option) => !used.has(option.id))

  const addMember = (expertId: string): void => {
    if (expertId === '' || used.has(expertId) || draft.members.length >= 8) return
    onChange({ ...draft, members: [...draft.members, { expertId, role: '' }] })
    setPick('')
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('teams.editor.title')}
      closeLabel={t('teams.action.close')}
      className="tentacle-team-dialog"
      contentClassName="tentacle-team-content"
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{t('teams.action.cancel')}</Button>
          <Button
            variant="primary"
            disabled={draft.members.length < 2 || draft.members.length > 8 || draft.name.trim() === ''}
            onClick={onSubmit}
          >
            {draft.id === undefined ? t('teams.action.createSubmit') : t('teams.action.save')}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', minWidth: 0 }}>
        {builtin ? <p style={{ ...styles.sectionHint, color: colors.accent }}>{t('teams.editor.builtinFixed')}</p> : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>{t('teams.editor.name')}</span>
            <Input
              value={draft.name}
              disabled={builtin}
              placeholder="产品评审"
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ ...styles.field, flex: 1 }}>
              <span style={styles.fieldLabel}>{t('teams.editor.icon')}</span>
              <Input
                value={draft.icon}
                disabled={builtin}
                placeholder="🧭"
                onChange={(event) => onChange({ ...draft, icon: event.target.value })}
              />
            </label>
            <label style={{ ...styles.field, flex: 1 }}>
              <span style={styles.fieldLabel}>{t('teams.editor.color')}</span>
              <Input
                value={draft.color}
                disabled={builtin}
                placeholder="#7c3aed"
                onChange={(event) => onChange({ ...draft, color: event.target.value })}
              />
            </label>
          </div>
        </div>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>{t('teams.editor.description')}</span>
          <Input
            value={draft.description}
            disabled={builtin}
            placeholder="从工程与产品两个视角评审"
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
          />
        </label>

        <section style={styles.section}>
          <span style={styles.fieldLabel}>{t('teams.editor.members')}</span>
          <span style={styles.fieldHint}>{t('teams.editor.membersHint')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {draft.members.map((member, index) => {
              const option = options.find((o) => o.id === member.expertId)
              return (
                <div key={member.expertId} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                  <div style={styles.memberIndex}>{index + 1}</div>
                  <div style={{ fontSize: 12, color: colors.text, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{option === undefined ? member.expertId : text(option.name)}</div>
                    <div style={{ ...styles.mono, color: colors.tertiary }}>{member.expertId}</div>
                  </div>
                  <Input
                    value={member.role}
                    placeholder={t('teams.editor.role')}
                    onChange={(event) => onChange({
                      ...draft,
                      members: draft.members.map((m) => m.expertId === member.expertId ? { ...m, role: event.target.value } : m),
                    })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange({ ...draft, members: draft.members.filter((m) => m.expertId !== member.expertId) })}
                  >
                    <IconCloseOutlineRegular size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={pick}
              disabled={available.length === 0 || draft.members.length >= 8}
              onChange={(event) => addMember(event.target.value)}
              style={{
                flex: 1,
                height: 28,
                padding: '0 8px',
                borderRadius: 'var(--dsw-radius-sm, 8px)',
                border: `1px solid ${colors.borderControl}`,
                background: colors.layer1,
                color: colors.text,
                fontSize: 12,
              }}
            >
              <option value="">{t('teams.editor.pickMember')}</option>
              {available.map((option) => (
                <option key={option.id} value={option.id}>{text(option.name)}（{option.id}）</option>
              ))}
            </select>
            <Button size="sm" variant="outline" disabled={pick === ''} onClick={() => addMember(pick)}>
              <IconPlusOutlineRegular size={14} />
              {t('teams.editor.addMember')}
            </Button>
          </div>
        </section>

        <section style={styles.section}>
          <span style={styles.fieldLabel}>{t('teams.detail.contract')}</span>
          <label style={styles.field}>
            <span style={styles.fieldHint}>{t('teams.editor.goal')}</span>
            <textarea
              style={styles.textarea}
              value={draft.goal}
              placeholder="给出通过/驳回结论"
              onChange={(event) => onChange({ ...draft, goal: event.target.value })}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldHint}>{t('teams.editor.constraints')}</span>
            <textarea
              style={styles.textarea}
              value={draft.constraints}
              placeholder={'结论先行\n引用必须给出处'}
              onChange={(event) => onChange({ ...draft, constraints: event.target.value })}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldHint}>{t('teams.editor.delivery')}</span>
            <textarea
              style={styles.textarea}
              value={draft.delivery}
              placeholder="每人一段结论 + ≤3 句收口"
              onChange={(event) => onChange({ ...draft, delivery: event.target.value })}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldHint}>{t('teams.editor.examples')}</span>
            <textarea
              style={styles.textarea}
              value={draft.examples}
              placeholder="评审这个 PR"
              onChange={(event) => onChange({ ...draft, examples: event.target.value })}
            />
          </label>
        </section>

        <section style={styles.section}>
          <span style={styles.fieldLabel}>{t('teams.editor.collaboration')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant={draft.collaboration === 'dispatch' ? 'primary' : 'outline'} onClick={() => onChange({ ...draft, collaboration: 'dispatch' })}>
              {t('teams.badge.dispatch')}
            </Button>
            <Button size="sm" variant={draft.collaboration === 'auto' ? 'primary' : 'outline'} onClick={() => onChange({ ...draft, collaboration: 'auto' })}>
              {t('teams.badge.auto')}
            </Button>
          </div>
        </section>

        <section style={styles.section}>
          <span style={styles.fieldLabel}>{t('teams.detail.routing')}</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={styles.field}>
              <span style={styles.fieldHint}>{t('teams.card.model')}</span>
              <Input
                value={draft.modelProvider}
                placeholder="provider"
                onChange={(event) => onChange({ ...draft, modelProvider: event.target.value })}
              />
            </label>
            <label style={styles.field}>
              <span style={styles.fieldHint}>&nbsp;</span>
              <Input
                value={draft.modelName}
                placeholder="model"
                onChange={(event) => onChange({ ...draft, modelName: event.target.value })}
              />
            </label>
          </div>
          <label style={styles.field}>
            <span style={styles.fieldHint}>{t('teams.card.permission')}</span>
            <Input
              value={draft.permissionPreset}
              placeholder={t('teams.editor.default')}
              onChange={(event) => onChange({ ...draft, permissionPreset: event.target.value })}
            />
          </label>
        </section>
      </div>
    </Modal>
  )
}

/** Delete confirmation for non-builtin teams. */
export function DeleteTeamDialog({ team, t, onConfirm, onClose }: {
  team: TeamRow
  t: Translate
  onConfirm: () => void
  onClose: () => void
}): ReactElement {
  return (
    <Modal
      open
      onClose={onClose}
      title={t('teams.delete.title')}
      closeLabel={t('teams.action.close')}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{t('teams.action.cancel')}</Button>
          <Button variant="primary" onClick={onConfirm}>
            <IconTrashOutlineRegular size={14} />
            {t('teams.action.delete')}
          </Button>
        </div>
      )}
    >
      <p style={{ margin: 0, fontSize: 13, color: colors.text }}>
        {fmt(t('teams.delete.confirm'), { name: text(team.name) })}
      </p>
    </Modal>
  )
}
