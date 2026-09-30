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
    var result = await client.auth.signInWithPassword({
      email: email,
      password: password
    });
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
      .insert({
        user_id: user.id,
        display_name: displayName
      })
      .select("user_id,display_name,role,active")
      .single();

    if (inserted.error) throw inserted.error;
    return inserted.data;
  }

  function onAuthStateChange(callback) {
    return client.auth.onAuthStateChange(callback);
  }

  async function getReceiptMasters() {
    var results = await Promise.all([
      client.from("sap_warehouses")
        .select("id,code,name,warehouse_type,active,center:sap_centers(code,name),location:locations(name,department),organization:organizations(name)")
        .eq("active", true)
        .order("code"),
      client.from("organizations").select("id,name,organization_type,active").eq("active", true).order("name")
    ]);
    if (results[0].error) throw results[0].error;
    if (results[1].error) throw results[1].error;
    return { warehouses: results[0].data || [], organizations: results[1].data || [] };
  }

  async function queryInChunks(table, select, column, values, size) {
    var unique = Array.from(new Set((values || []).filter(Boolean)));
    var rows = [];
    size = size || 150;
    for (var i = 0; i < unique.length; i += size) {
      var result = await client.from(table).select(select).in(column, unique.slice(i, i + size));
      if (result.error) throw result.error;
      rows = rows.concat(result.data || []);
    }
    return rows;
  }

  async function findMaterials(sapCodes) {
    return queryInChunks(
      "materials",
      "id,sap_code,description,category,serialized,active",
      "sap_code",
      (sapCodes || []).map(function (x) { return String(x).trim().toUpperCase(); })
    );
  }

  async function findEquipment(serials) {
    return queryInChunks(
      "equipment",
      "id,serial,current_status,current_warehouse_id,material:materials(sap_code,description),warehouse:sap_warehouses(code,name,location:locations(name))",
      "serial",
      (serials || []).map(function (x) { return String(x).trim().toUpperCase(); })
    );
  }

  async function createReceipt(payload) {
    var result = await client.rpc("create_pulso_receipt", { p_payload: payload });
    if (result.error) throw result.error;
    return result.data;
  }

  async function listReceipts(limit) {
    var result = await client
      .from("receipts")
      .select("id,pulso_code,effective_date,record_origin,info_status,source_document,registered_at,source_organization:organizations!receipts_source_organization_id_fkey(name),destination_warehouse:sap_warehouses!receipts_destination_warehouse_id_fkey(code,name,location:locations(name)),items:receipt_items(id,serial_snapshot,quantity)")
      .order("effective_date", { ascending: false })
      .limit(limit || 100);
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
    onAuthStateChange: onAuthStateChange,
    getReceiptMasters: getReceiptMasters,
    findMaterials: findMaterials,
    findEquipment: findEquipment,
    createReceipt: createReceipt,
    listReceipts: listReceipts
  };
})();