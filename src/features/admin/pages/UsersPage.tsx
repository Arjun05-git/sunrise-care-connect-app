import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Copy, Search, UserCog, UserPlus } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';
import { inviteStaff, setStaffRoles, useUsers, type StaffRole, type UserRow } from '../console-api';

const STAFF: StaffRole[] = ['admin', 'coordinator', 'finance'];
const KINDS = ['staff', 'doctor', 'patient', 'all'] as const;

/** Users & roles (admins only): staff roles with a reason; nobody changes their own; the last admin stays. */
export function UsersPage() {
  const { t, i18n } = useTranslation();
  const isAdmin = useHasRole('admin');
  const { session } = useAuth();
  const qc = useQueryClient();
  const errText = useAdminError();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('staff');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => { const h = setTimeout(() => { setTerm(q.trim()); setPage(0); }, 300); return () => clearTimeout(h); }, [q]);
  const users = useUsers({ q: term, kind, page });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', roles: ['coordinator'] as StaffRole[] });
  const [link, setLink] = useState<string | null>(null);
  if (!isAdmin) return <div className="space-y-4"><PageHeader title={t('admin.users')} /><ReadOnlyNote>{t('adm.users.adminOnly')}</ReadOnlyNote></div>;

  const rows = users.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((users.data?.total ?? 0) / 50));
  const refresh = () => qc.invalidateQueries({ queryKey: ['console', 'users'] });
  const saveRoles = async (reason: string) => {
    if (!editing) return;
    setBusy(true);
    try {
      await setStaffRoles(editing.id, roles, reason);
      toast.success(t('adm.users.saved'));
      setEditing(null);
      await refresh();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const sendInvite = async (reason: string) => {
    setBusy(true);
    try {
      const r = await inviteStaff(invite.email.trim(), invite.name.trim(), invite.roles, reason);
      setInviting(false);
      setInvite({ email: '', name: '', roles: ['coordinator'] });
      if (r.invite_link) setLink(r.invite_link); else toast.success(t('adm.users.invited'));
      await refresh();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (list: StaffRole[], r: StaffRole, on: boolean) => (on ? [...new Set([...list, r])] : list.filter((x) => x !== r));

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.users')} subtitle={t('adm.users.subtitle')} actions={<Button onClick={() => setInviting(true)} data-ref="invite"><UserPlus aria-hidden />{t('adm.users.invite')}</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented aria-label={t('adm.users.kindLabel')} value={kind} onValueChange={(v) => { setKind(v as typeof kind); setPage(0); }}
          options={KINDS.map((k) => ({ value: k, label: t(`adm.users.kind.${k}`) }))} />
        <div className="relative ml-auto w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.users.search')} aria-label={t('adm.users.search')} /></div>
      </div>
      {users.isPending ? <ListSkeleton rows={5} /> : users.isError ? <ErrorState onRetry={() => void users.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="users" title={t('adm.users.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-ref="users-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">{['name', 'contact', 'roles', 'lastSignIn', ''].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h && t(`adm.users.col.${h}`)}</th>)}</tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.id} className="border-b last:border-0">
                <td className="px-4 py-2.5 font-medium">{u.full_name || '—'}{u.id === session?.user.id && <Badge variant="outline" className="ml-1">{t('adm.users.you')}</Badge>}</td>
                <td className="px-4 py-2.5 text-xs">{u.email ?? u.phone ?? '—'}</td>
                <td className="px-4 py-2.5">{u.roles.length ? u.roles.map((r) => <Badge key={r} variant={STAFF.includes(r as StaffRole) ? 'default' : 'neutral'} className="mr-1">{t(`roles.${r}`)}</Badge>) : <span className="text-xs text-muted-foreground">{t('adm.users.noRoles')}</span>}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at, i18n.language) : t('adm.users.never')}</td>
                <td className="px-4 py-2.5 text-right">
                  {u.email && u.id !== session?.user.id && !u.roles.includes('doctor') && !u.roles.includes('patient') && (
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(u); setRoles(u.roles.filter((r): r is StaffRole => STAFF.includes(r as StaffRole))); }} aria-label={t('adm.users.editRoles', { name: u.full_name })}>
                      <UserCog className="h-4 w-4" aria-hidden />{t('adm.users.roles')}</Button>
                  )}
                </td>
              </tr>))}</tbody>
          </table>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 p-3 text-sm">
              <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t('notify.admin.prev')}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{page + 1}/{pages}</span>
              <Button size="icon" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t('notify.admin.next')}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
        </Card>
      )}
      <p className="text-xs text-muted-foreground">{t('adm.users.rules')}</p>

      <ReasonDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={t('adm.users.editRoles', { name: editing?.full_name })}
        description={roles.length === 0 ? t('adm.users.revoke') : undefined} destructive={roles.length === 0} confirmLabel={t('common.save')} busy={busy} onConfirm={(r) => void saveRoles(r)}>
        <RolePicker value={roles} onChange={(r, on) => setRoles(toggle(roles, r, on))} />
      </ReasonDialog>

      <ReasonDialog open={inviting} onOpenChange={setInviting} title={t('adm.users.invite')} description={t('adm.users.inviteHint')} confirmLabel={t('adm.users.send')} busy={busy}
        valid={/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(invite.email.trim()) && invite.name.trim().length >= 3 && invite.roles.length > 0} onConfirm={(r) => void sendInvite(r)}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="i-name">{t('adm.users.name')}</Label><Input id="i-name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="i-email">{t('adm.users.email')}</Label><Input id="i-email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></div>
        </div>
        <RolePicker value={invite.roles} onChange={(r, on) => setInvite({ ...invite, roles: toggle(invite.roles, r, on) })} />
      </ReasonDialog>

      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('adm.users.linkTitle')}</DialogTitle><DialogDescription>{t('adm.users.linkHint')}</DialogDescription></DialogHeader>
          <Input readOnly value={link ?? ''} data-ref="invite-link" onFocus={(e) => e.target.select()} />
          <DialogFooter><Button onClick={() => void navigator.clipboard?.writeText(link ?? '').then(() => toast.success(t('adm.users.copied')))}><Copy aria-hidden />{t('adm.users.copy')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RolePicker({ value, onChange }: { value: StaffRole[]; onChange: (r: StaffRole, on: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{t('adm.users.roles')}</legend>
      {STAFF.map((r) => (
        <label key={r} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
          <Checkbox checked={value.includes(r)} onCheckedChange={(v) => onChange(r, !!v)} className="mt-0.5" />
          <span><span className="font-medium">{t(`roles.${r}`)}</span><span className="block text-xs text-muted-foreground">{t(`adm.users.roleHint.${r}`)}</span></span>
        </label>
      ))}
    </fieldset>
  );
}
