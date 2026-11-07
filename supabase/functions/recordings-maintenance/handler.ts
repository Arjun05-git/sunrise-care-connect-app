// Daily recording housekeeping: fails recordings stuck in recording/uploading, and purges recordings past their retention
// (media removed from storage, then the record marked deleted). A legal hold is never purged. Service-role only: called by the
// scheduler (pg_cron + pg_net on Supabase; the local gateway's timer).
import { handler, HttpError, isServiceCall, json, serviceClient } from '../_shared/http.ts';
import { runRecordingMaintenance } from '../_shared/recording.ts';

const BUCKET = 'consult-recordings';

export default handler(async (req) => {
  if (!isServiceCall(req)) throw new HttpError('forbidden', 403);
  const svc = serviceClient();
  const store = svc.storage.from(BUCKET);
  const result = await runRecordingMaintenance({
    expireStale: async () => {
      const { data, error } = await svc.rpc('expire_stale_recordings', { p_hours: 6 });
      if (error) throw error;
      return Number(data);
    },
    due: async () => {
      const { data, error } = await svc.rpc('recordings_due_for_purge', { p_limit: 100 });
      if (error) throw error;
      return (data as { id: string; storage_prefix: string }[]).map((r) => ({ id: r.id, prefix: r.storage_prefix }));
    },
    listNames: async (prefix) => {
      const { data, error } = await store.list(prefix.replace(/\/$/, ''), { limit: 10000 });
      if (error) throw error;
      return data.map((o) => o.name);
    },
    remove: async (paths) => {
      const { error } = await store.remove(paths);
      if (error) throw error;
    },
    markDeleted: async (id) => {
      const { error } = await svc.rpc('mark_recording_deleted', { p_rec: id });
      if (error) throw error;
    },
  });
  return json(req, result);
});
