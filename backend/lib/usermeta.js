// One safe way to change a user's auth metadata (style settings, locked chat names, easter eggs all live there).
// Each change is read-modify-write on the WHOLE metadata object, so two changes for the same person running at the same
// moment (two tabs, or a style command and an easter egg) used to overwrite each other. Here changes for one user run one
// after another, and each one re-reads the current metadata inside its turn.
function createUserMeta({ supabaseAdmin, auth }) {
  const queues = new Map(); // userId -> the last queued change

  async function apply(userId, change) {
    const { data, error: readError } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (readError || !data || !data.user) throw new Error((readError && readError.message) || "User not found");
    const current = data.user.user_metadata || {};
    const patch = typeof change === "function" ? change(current) : change;
    const next = { ...current, ...patch };
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: next });
    if (error) throw new Error(error.message);
    auth.invalidate(userId);
    return next;
  }

  function patch(userId, change) {
    const previous = queues.get(userId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => apply(userId, change));
    queues.set(userId, run);
    run.then(() => {}, () => {}).then(() => { if (queues.get(userId) === run) queues.delete(userId); });
    return run;
  }

  return { patch };
}

module.exports = { createUserMeta };
