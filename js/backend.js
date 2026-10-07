(function () {
  "use strict";

  var cfg = window.PULSO_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    window.PULSO_BACKEND = { ready: false };
    return;
  }

  var client = window.supabase.createClient(
    cfg.supabaseUrl,
    cfg.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  async function signIn(email, password) {
    var result = await client.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signOut() {
    var result = await client.auth.signOut();
    if (result.error) throw result.error;
  }

  async function getSession() {
    var result = await client.auth.getSession();
    if (result.error) throw result.error;
    return result.data.session;
  }

  async function ensureProfile(user) {
    if (!user) return null;

    var found = await client
      .from("profiles")
      .select("user_id,display_name,role,active")
      .eq("user_id", user.id)
      .maybeSingle();

    if (found.error) throw found.error;
    if (found.data) return found.data;

    var displayName =
      (user.user_metadata && user.user_metadata.display_name) ||
      String(user.email || "Usuario").split("@")[0];

    var inserted = await client
      .from("profiles")
      .insert({ user_id: user.id, display_name: displayName })
      .select("user_id,display_name,role,active")
      .single();

    if (inserted.error) throw inserted.error;
    return inserted.data;
  }

  async function getPrealertMaster() {
    var result = await client
      .from("prealerta_master")
      .select("sap_code,description,segment,diagnosticable,profile")
      .order("sap_code");

    if (result.error) throw result.error;
    return result.data || [];
  }

  window.PULSO_BACKEND = {
    ready: true,
    client: client,
    signIn: signIn,
    signOut: signOut,
    getSession: getSession,
    ensureProfile: ensureProfile,
    getPrealertMaster: getPrealertMaster
  };
})();