(function () {
  "use strict";

  var currentProfile = null;
  var masterRows = [];
  var masterMap = new Map();
  var sources = {
    iq: { file: null, rows: [], sheet: "", ready: false, error: "" },
    control: { file: null, rows: [], sheet: "", ready: false, error: "" },
    removed: { file: null, rows: [], sheet: "", ready: false, error: "" }
  };
  var analysis = null;
  var activeResultTab = "prealert";

  var CITY_CONFIG = {
    Riohacha: {
      aliases: ["RIOHACHA", "A221", "Q221", "U020"],
      outputWarehouse: "A221",
      serialAllowed: ["A221", "Q221", "U020", ""],
      warrantyAllowed: ["A221", "U020"],
      regional: "COSTA"
    },
    Valledupar: {
      aliases: ["VALLEDUPAR", "A223", "A224", "Q223", "Q224", "U036", "U037"],
      outputWarehouse: "A223",
      serialAllowed: ["A223", "A224", "Q223", "Q224", "U036", "U037", ""],
      warrantyAllowed: ["A223", "U036"],
      regional: "COSTA"
    }
  };

  var SOURCE_DEFS = {
    iq: {
      inputId: "fileIq", nameId: "nameIq", metaId: "metaIq", stateId: "stateIq",
      label: "IQ",
      fields: {
        serial: ["Número de serie", "Numero de serie", "Serial", "N° serie", "Nro serie"],
        material: ["Material", "Código SAP", "Codigo SAP"],
        description: ["Denominación", "Denominacion", "Descripción", "Descripcion"],
        center: ["Centro"],
        warehouse: ["Almacén", "Almacen", "Bodega SAP"],
        systemStatus: ["Status sistema", "Estado sistema"],
        lot: ["Lote de stock", "Lote"],
        stockType: ["Tipo stocks", "Tipo stock"]
      },
      required: ["serial", "material", "warehouse"]
    },
    control: {
      inputId: "fileControl", nameId: "nameControl", metaId: "metaControl", stateId: "stateControl",
      label: "Control de retirados",
      fields: {
        city: ["Bodega Base", "Bodega", "Ciudad"],
        designation: ["Designación del repuesto", "Designacion del repuesto", "Designación de repuesto", "Designacion de repuesto"],
        assignedDate: ["Fecha de Asignación del Repuesto", "Fecha de Asignacion del Repuesto"],
        technician: ["Técnico Instalador", "Tecnico Instalador"],
        date: ["Fecha de Instalación del Repuesto", "Fecha de Instalacion del Repuesto", "Fecha de retirado", "Fecha retirado"],
        beneficiaryId: ["ID Beneficiario de Instalación", "ID Beneficiario de Instalacion", "ID Beneficiario", "ID"],
        sap: ["SAP de Repuesto retirado", "SAP de Repuesto Retirado", "Código SAP retirado", "Codigo SAP retirado", "SAP retirado"],
        detail: ["Detalle del Repuesto2", "Detalle del Repuesto", "Descripción", "Descripcion"],
        serial: ["Serial de Repuesto Retirado", "Serial de repuesto retirado", "Serial retirado"],
        finalStatus: ["Estado Final de Repuesto", "Estado final de repuesto"]
      },
      required: ["city", "designation", "date", "beneficiaryId", "sap"]
    },
    removed: {
      inputId: "fileRemoved", nameId: "nameRemoved", metaId: "metaRemoved", stateId: "stateRemoved",
      label: "Desmontados",
      fields: {
        sap: ["Codigo SAP", "Código SAP", "Material"],
        description: ["Descripción Material", "Descripcion Material", "Descripción", "Descripcion"],
        typeOt: ["Tipo OT"],
        quantity: ["Cantidad"],
        date: ["Fecha"],
        node: ["Nodo"],
        beneficiaryId: ["ID", "ID Beneficiario"],
        workOrder: ["Orden de Trabajo", "Orden Trabajo", "OT"],
        serial: ["Serial"],
        center: ["Centro"],
        warehouse: ["Bodega SAP", "Almacén", "Almacen"]
      },
      required: ["sap", "date", "beneficiaryId", "workOrder"]
    }
  };

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function toast(message) {
    var el = byId("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(window.__pulsoToast);
    window.__pulsoToast = setTimeout(function () { el.classList.remove("show"); }, 3200);
  }

  function normalizeText(value) {
    if (value == null) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
    }
    return String(value).trim();
  }

  function normalizeKey(value) {
    return normalizeText(value)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  }

  function normalizeCode(value) {
    var text = normalizeText(value).replace(/\.0+$/, "").trim();
    return text.toUpperCase();
  }

  function normalizeSerial(value) {
    return normalizeText(value).trim().toUpperCase();
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function isRejected(value) {
    return normalizeKey(value) === "RECHAZADO";
  }

  function isLogytech(master) {
    return master && normalizeKey(master.segment).indexOf("LOGYTECH") >= 0;
  }

  function profileType(master) {
    var p = normalizeKey(master && master.profile);
    if (p === "CON PERFIL DE SERIE") return "SERIAL";
    if (p === "SIN PERFIL DE SERIE") return "NONSERIAL";
    return "";
  }

  function toDate(value) {
    if (!value && value !== 0) return null;
    if (value instanceof Date && !isNaN(value.getTime())) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      var parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
    }
    var text = normalizeText(value);
    if (!text) return null;

    var m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      var year = Number(m[3]); if (year < 100) year += 2000;
      return new Date(year, Number(m[2]) - 1, Number(m[1]));
    }

    var iso = text.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

    var d = new Date(text);
    return isNaN(d.getTime()) ? null : d;
  }

  function dateKey(value) {
    var d = toDate(value);
    if (!d) return "";
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  }

  function dateLabel(value) {
    var key = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dateKey(value);
    if (!key) return "";
    var p = key.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  function dateObject(value) {
    var key = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dateKey(value);
    if (!key) return null;
    var p = key.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function generationSuffix() {
    var d = new Date();
    return String(d.getDate()).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0") + String(d.getFullYear()).slice(-2);
  }

  function resolveCity(value) {
    var key = normalizeKey(value);
    if (!key) return "";
    var names = Object.keys(CITY_CONFIG);
    for (var i = 0; i < names.length; i++) {
      var city = names[i];
      var aliases = CITY_CONFIG[city].aliases;
      if (normalizeKey(city) === key || aliases.some(function (a) { return key.indexOf(normalizeKey(a)) >= 0; })) return city;
    }
    return "";
  }

  function showApp() {
    byId("loginView").classList.add("hidden");
    byId("appView").classList.remove("hidden");
    if (currentProfile) {
      byId("logoutButton").textContent = (currentProfile.display_name || "P").charAt(0).toUpperCase();
      byId("logoutButton").title = (currentProfile.display_name || "Usuario") + " · Cerrar sesión";
    }
    loadMaster();
  }

  function showLogin() {
    byId("appView").classList.add("hidden");
    byId("loginView").classList.remove("hidden");
  }

  async function initSession() {
    var remembered = localStorage.getItem("pulso_remember_user");
    if (remembered) {
      byId("loginUser").value = remembered;
      byId("rememberMe").checked = true;
    }
    if (!window.PULSO_BACKEND || !window.PULSO_BACKEND.ready) {
      showLogin(); toast("No fue posible inicializar la conexión segura con Supabase."); return;
    }
    try {
      var session = await window.PULSO_BACKEND.getSession();
      if (session && session.user) {
        currentProfile = await window.PULSO_BACKEND.ensureProfile(session.user);
        if (!currentProfile.active) {
          await window.PULSO_BACKEND.signOut();
          currentProfile = null; showLogin(); toast("Tu usuario está inactivo en PULSO."); return;
        }
        showApp();
      } else showLogin();
    } catch (error) {
      console.error(error); showLogin(); toast("No fue posible validar la sesión.");
    }
  }

  async function loadMaster() {
    var pill = byId("masterPill");
    var status = byId("masterStatus");
    pill.classList.remove("ready", "error");
    status.textContent = "Cargando...";
    try {
      masterRows = await window.PULSO_BACKEND.getPrealertMaster();
      masterMap = new Map();
      masterRows.forEach(function (row) { masterMap.set(normalizeCode(row.sap_code), row); });
      status.textContent = masterRows.length + " materiales cargados";
      pill.classList.add("ready");
      refreshRunState();
    } catch (error) {
      console.error(error);
      status.textContent = "Error al cargar";
      pill.classList.add("error");
      toast("No fue posible cargar el maestro interno.");
    }
  }

  function bindAuth() {
    byId("loginForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      var user = byId("loginUser").value.trim();
      var password = byId("loginPassword").value;
      var submit = event.currentTarget.querySelector('button[type="submit"]');
      if (!user || !password) return;

      if (byId("rememberMe").checked) localStorage.setItem("pulso_remember_user", user);
      else localStorage.removeItem("pulso_remember_user");

      submit.disabled = true;
      submit.innerHTML = "Validando acceso...";
      try {
        var auth = await window.PULSO_BACKEND.signIn(user, password);
        currentProfile = await window.PULSO_BACKEND.ensureProfile(auth.user);
        if (!currentProfile.active) {
          await window.PULSO_BACKEND.signOut(); currentProfile = null; throw new Error("Usuario inactivo");
        }
        showApp(); toast("Acceso confirmado.");
      } catch (error) {
        console.error(error);
        toast(error && error.message === "Usuario inactivo" ? "Tu usuario está inactivo en PULSO." : "Correo o contraseña incorrectos.");
      } finally {
        submit.disabled = false;
        submit.innerHTML = 'Ingresar <span>→</span>';
      }
    });

    byId("togglePassword").addEventListener("click", function () {
      var input = byId("loginPassword");
      input.type = input.type === "password" ? "text" : "password";
    });
    byId("forgotPassword").addEventListener("click", function () { toast("La recuperación de contraseña se habilitará en una siguiente iteración."); });
    byId("corporateAccess").addEventListener("click", function () { toast("El acceso corporativo se habilitará cuando se defina el proveedor SSO."); });
    byId("logoutButton").addEventListener("click", async function () {
      try { await window.PULSO_BACKEND.signOut(); } catch (error) { console.error(error); }
      currentProfile = null; showLogin();
    });
    byId("menuButton").addEventListener("click", function () { document.querySelector(".sidebar").classList.toggle("open"); });
  }

  function topMatrix(sheet, maxRows) {
    var ref = sheet["!ref"];
    if (!ref) return [];
    var range = XLSX.utils.decode_range(ref);
    range.e.r = Math.min(range.e.r, (maxRows || 25) - 1);
    range.e.c = Math.min(range.e.c, 51);
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, range: XLSX.utils.encode_range(range) });
  }

  function aliasSet(aliases) {
    return aliases.map(normalizeKey);
  }

  function locateHeader(matrix, def) {
    var required = def.required || [];
    var best = null;
    for (var r = 0; r < Math.min(matrix.length, 30); r++) {
      var normalized = (matrix[r] || []).map(normalizeKey);
      var matched = 0;
      required.forEach(function (field) {
        var aliases = aliasSet(def.fields[field] || []);
        if (normalized.some(function (h) { return aliases.indexOf(h) >= 0; })) matched++;
      });
      if (!best || matched > best.matched) best = { row: r, matched: matched, normalized: normalized };
    }
    return best;
  }

  function chooseSheet(workbook, def) {
    var winner = null;
    workbook.SheetNames.forEach(function (name) {
      var sheet = workbook.Sheets[name];
      var matrix = topMatrix(sheet, 30);
      var probe = locateHeader(matrix, def);
      if (!winner || probe.matched > winner.matched) winner = { name: name, sheet: sheet, matched: probe.matched, headerRow: probe.row };
    });
    if (!winner || winner.matched < def.required.length) {
      throw new Error("No encontré una hoja con las columnas requeridas para " + def.label + ".");
    }
    return winner;
  }

  function buildColumnMap(headers, def) {
    var normalized = headers.map(normalizeKey);
    var map = {};
    Object.keys(def.fields).forEach(function (field) {
      var aliases = aliasSet(def.fields[field]);
      var idx = -1;
      for (var i = 0; i < normalized.length; i++) {
        if (aliases.indexOf(normalized[i]) >= 0) { idx = i; break; }
      }
      map[field] = idx;
    });
    def.required.forEach(function (field) {
      if (map[field] < 0) throw new Error("Falta la columna " + def.fields[field][0] + ".");
    });
    return map;
  }

  function extractRows(sheet, headerRow, def) {
    var matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    if (!matrix.length || !matrix[headerRow]) return [];
    var map = buildColumnMap(matrix[headerRow], def);
    var rows = [];
    for (var r = headerRow + 1; r < matrix.length; r++) {
      var source = matrix[r] || [];
      var item = { __row: r + 1 };
      var meaningful = false;
      Object.keys(map).forEach(function (field) {
        item[field] = map[field] >= 0 ? source[map[field]] : "";
        if (normalizeText(item[field])) meaningful = true;
      });
      if (meaningful) rows.push(item);
    }
    return rows;
  }

  async function parseSource(key, file) {
    var def = SOURCE_DEFS[key];
    var state = sources[key];
    state.file = file; state.ready = false; state.error = ""; state.rows = []; state.sheet = "";
    setSourceUi(key, "loading", file.name, "Leyendo y validando estructura...");

    try {
      var buffer = await file.arrayBuffer();
      var workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      var selected = chooseSheet(workbook, def);
      var rows = extractRows(selected.sheet, selected.headerRow, def);
      if (!rows.length) throw new Error("La hoja seleccionada no contiene registros.");

      state.rows = rows; state.sheet = selected.name; state.ready = true;
      setSourceUi(key, "loaded", file.name, rows.length.toLocaleString("es-CO") + " registros · hoja " + selected.name);
      toast(def.label + " cargado correctamente.");
    } catch (error) {
      console.error(error);
      state.error = error.message || "Archivo inválido";
      setSourceUi(key, "error", file.name, state.error);
      toast(def.label + ": " + state.error);
    }
    analysis = null;
    byId("resultSection").classList.add("hidden");
    refreshRunState();
  }

  function setSourceUi(key, mode, title, meta) {
    var def = SOURCE_DEFS[key];
    byId(def.nameId).textContent = title;
    byId(def.metaId).textContent = meta;
    var stateEl = byId(def.stateId);
    var card = document.querySelector('.source-card[data-source="' + key + '"]');
    var drop = document.querySelector('.source-dropzone[data-drop="' + key + '"]');
    stateEl.className = "source-state " + mode;
    stateEl.querySelector("small").textContent = mode === "loaded" ? "Listo" : (mode === "error" ? "Revisar" : (mode === "loading" ? "Procesando" : "Pendiente"));
    card.classList.remove("loaded", "error", "loading");
    drop.classList.remove("loaded", "error", "loading");
    card.classList.add(mode); drop.classList.add(mode);
  }

  function refreshRunState() {
    var loaded = Object.keys(sources).filter(function (k) { return sources[k].ready; }).length;
    var masterReady = masterRows.length > 0;
    var button = byId("runPrealert");
    button.disabled = loaded !== 3 || !masterReady;

    if (!masterReady) {
      byId("processTitle").textContent = "Cargando maestro interno";
      byId("processText").textContent = "PULSO necesita el maestro de segmentación y perfil para procesar.";
    } else if (loaded < 3) {
      byId("processTitle").textContent = "Esperando " + (3 - loaded) + " fuente(s)";
      byId("processText").textContent = "Los archivos se procesan en tu navegador. No se almacenan en PULSO.";
    } else {
      byId("processTitle").textContent = "Todo listo para analizar";
      byId("processText").textContent = "PULSO cruzará " +
        sources.iq.rows.length.toLocaleString("es-CO") + " IQ · " +
        sources.control.rows.length.toLocaleString("es-CO") + " retirados · " +
        sources.removed.rows.length.toLocaleString("es-CO") + " desmontados.";
    }
  }

  function bindSources() {
    document.querySelectorAll("[data-pick]").forEach(function (button) {
      button.addEventListener("click", function () { byId(SOURCE_DEFS[button.dataset.pick].inputId).click(); });
    });

    Object.keys(SOURCE_DEFS).forEach(function (key) {
      var def = SOURCE_DEFS[key];
      byId(def.inputId).addEventListener("change", function (event) {
        var file = event.target.files && event.target.files[0];
        if (file) parseSource(key, file);
      });

      var drop = document.querySelector('.source-dropzone[data-drop="' + key + '"]');
      ["dragenter", "dragover"].forEach(function (name) {
        drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.add("dragging"); });
      });
      ["dragleave", "drop"].forEach(function (name) {
        drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.remove("dragging"); });
      });
      drop.addEventListener("drop", function (event) {
        var file = event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) parseSource(key, file);
      });
    });

    byId("runPrealert").addEventListener("click", processPrealert);
  }

  function removedKey(sap, date, beneficiaryId) {
    return normalizeCode(sap) + "|" + dateKey(date) + "|" + normalizeCode(beneficiaryId);
  }

  function buildIndexes() {
    var iq = new Map();
    var iqCount = new Map();
    sources.iq.rows.forEach(function (row) {
      var serial = normalizeSerial(row.serial);
      if (!serial) return;
      iqCount.set(serial, (iqCount.get(serial) || 0) + 1);
      if (!iq.has(serial)) {
        iq.set(serial, {
          row: row.__row,
          serial: serial,
          material: normalizeCode(row.material),
          description: normalizeText(row.description),
          center: normalizeCode(row.center),
          warehouse: normalizeCode(row.warehouse),
          systemStatus: normalizeText(row.systemStatus),
          lot: normalizeText(row.lot),
          stockType: normalizeCode(row.stockType)
        });
      }
    });

    var removed = new Map();
    var removedCount = new Map();
    sources.removed.rows.forEach(function (row) {
      var key = removedKey(row.sap, row.date, row.beneficiaryId);
      if (!normalizeCode(row.sap) || !dateKey(row.date) || !normalizeCode(row.beneficiaryId)) return;
      removedCount.set(key, (removedCount.get(key) || 0) + 1);
      if (!removed.has(key)) {
        removed.set(key, {
          row: row.__row,
          sap: normalizeCode(row.sap),
          date: dateKey(row.date),
          beneficiaryId: normalizeCode(row.beneficiaryId),
          workOrder: normalizeText(row.workOrder),
          serial: normalizeSerial(row.serial),
          warehouse: normalizeCode(row.warehouse)
        });
      }
    });

    return { iq: iq, iqCount: iqCount, removed: removed, removedCount: removedCount };
  }

  function pushReview(result, base, reason, severity) {
    result.review.push(Object.assign({}, base, { reason: reason, severity: severity || "WARNING" }));
  }

  function pushExcluded(result, base, reason) {
    result.excluded.push(Object.assign({}, base, { reason: reason }));
  }

  function processPrealert() {
    if (Object.keys(sources).some(function (k) { return !sources[k].ready; }) || !masterRows.length) return;

    var button = byId("runPrealert");
    button.disabled = true; button.textContent = "Procesando...";
    byId("processTitle").textContent = "Cruce operativo en curso";
    byId("processText").textContent = "Validando IQ, órdenes de trabajo, segmentación y perfil...";

    setTimeout(function () {
      try {
        var indexes = buildIndexes();
        var result = {
          cities: {},
          prealert: [],
          warranty: [],
          excluded: [],
          review: [],
          stats: { control: sources.control.rows.length, logytech: 0 }
        };

        Object.keys(CITY_CONFIG).forEach(function (city) {
          result.cities[city] = { serialized: [], nonSerialized: [], warranty: [] };
        });

        sources.control.rows.forEach(function (row) {
          var sap = normalizeCode(row.sap);
          var serial = normalizeSerial(row.serial);
          var date = dateKey(row.date);
          var beneficiaryId = normalizeCode(row.beneficiaryId);
          var city = resolveCity(row.city);
          var designation = normalizeText(row.designation);
          var master = masterMap.get(sap);
          var profile = profileType(master);
          var base = {
            sourceRow: row.__row,
            city: city || normalizeText(row.city) || "Sin ciudad",
            designation: designation,
            sap: sap,
            serial: serial,
            date: date,
            beneficiaryId: beneficiaryId,
            workOrder: "",
            iqWarehouse: "",
            iqMaterial: "",
            resultType: "",
            reason: ""
          };

          if (!sap) { pushReview(result, base, "El registro no tiene Código SAP retirado.", "ERROR"); return; }
          if (!city) { pushReview(result, base, "Ciudad/bodega base sin configuración en PULSO.", "ERROR"); return; }
          if (!master) { pushReview(result, base, "Código SAP no existe en el maestro interno.", "ERROR"); return; }
          if (!isLogytech(master)) {
            pushExcluded(result, base, master.segment ? "Segmentación: " + master.segment + "." : "Material no clasificado como procesable por Logytech.");
            return;
          }
          result.stats.logytech++;

          if (!profile) { pushReview(result, base, "El material no tiene perfil de serie definido.", "ERROR"); return; }

          var config = CITY_CONFIG[city];
          var iqEntry = serial ? indexes.iq.get(serial) : null;
          if (iqEntry) {
            base.iqWarehouse = iqEntry.warehouse;
            base.iqMaterial = iqEntry.material;
          }

          if (isRejected(designation)) {
            if (profile === "SERIAL") {
              if (!serial) { pushReview(result, base, "Garantía serializada sin serial.", "ERROR"); return; }
              if (!iqEntry) { pushExcluded(result, base, "Garantía serializada: el serial no aparece en IQ."); return; }
              if (config.warrantyAllowed.indexOf(iqEntry.warehouse) < 0) {
                pushExcluded(result, base, "Garantía: serial ubicado en IQ en " + (iqEntry.warehouse || "sin almacén") + ", fuera de bodegas permitidas.");
                return;
              }
            }

            var warranty = Object.assign({}, base, {
              resultType: "GARANTIA",
              description: master.description || normalizeText(row.detail),
              codeReported: sap,
              quantity: 1,
              lot: iqEntry && normalizeText(iqEntry.lot) ? normalizeText(iqEntry.lot) : "NOVALORADO",
              um: "",
              motive: "EQUIPO NO PERMITE CONFIGURACION",
              outputWarehouse: config.outputWarehouse
            });

            result.cities[city].warranty.push(warranty);
            result.warranty.push(warranty);

            if (serial && (indexes.iqCount.get(serial) || 0) > 1) {
              pushReview(result, warranty, "Serial repetido " + indexes.iqCount.get(serial) + " veces en IQ; PULSO usó la primera coincidencia.");
            }
            return;
          }

          if (!date) { pushReview(result, base, "No hay fecha de instalación/retiro para construir la llave de OT.", "ERROR"); return; }
          if (!beneficiaryId) { pushReview(result, base, "No hay ID Beneficiario para construir la llave de OT.", "ERROR"); return; }

          var rKey = removedKey(sap, date, beneficiaryId);
          var removedEntry = indexes.removed.get(rKey);
          if (!removedEntry || !removedEntry.workOrder) {
            pushReview(result, base, "No se encontró Orden de Trabajo en Desmontados para SAP + fecha + ID.", "ERROR");
            return;
          }
          base.workOrder = removedEntry.workOrder;

          if (profile === "SERIAL") {
            if (!serial) { pushReview(result, base, "Material con perfil de serie, pero el control no tiene serial retirado.", "ERROR"); return; }

            var outputCode = sap;
            if (iqEntry) {
              if (normalizeCode(iqEntry.stockType) === "01") {
                pushExcluded(result, base, "Tipo stock 01 en IQ.");
                return;
              }
              if (config.serialAllowed.indexOf(iqEntry.warehouse) < 0) {
                pushExcluded(result, base, "Serial ubicado en IQ en " + (iqEntry.warehouse || "sin almacén") + ", fuera de bodegas habilitadas.");
                return;
              }
              if (iqEntry.material) outputCode = iqEntry.material;
            }

            var serialRow = Object.assign({}, base, {
              resultType: "SERIALIZADO",
              outputWarehouse: config.outputWarehouse,
              codeReported: outputCode,
              quantity: 1
            });
            result.cities[city].serialized.push(serialRow);
            result.prealert.push(serialRow);

            if (!iqEntry) {
              pushReview(result, serialRow, "Serial no encontrado en IQ. El Excel original lo admite; se reporta con el SAP retirado.", "INFO");
            } else if (iqEntry.material && iqEntry.material !== sap) {
              pushReview(result, serialRow, "El SAP en IQ (" + iqEntry.material + ") difiere del SAP retirado (" + sap + "). Se reportará el SAP de IQ.");
            }
            if ((indexes.iqCount.get(serial) || 0) > 1) {
              pushReview(result, serialRow, "Serial repetido " + indexes.iqCount.get(serial) + " veces en IQ; PULSO usó la primera coincidencia.");
            }
          } else {
            var qty = sap === "1053943" ? 4 : 1;
            var nonSerialRow = Object.assign({}, base, {
              resultType: "NO SERIALIZADO",
              codeReported: sap,
              quantity: qty
            });
            result.cities[city].nonSerialized.push(nonSerialRow);
            result.prealert.push(nonSerialRow);
          }

          if ((indexes.removedCount.get(rKey) || 0) > 1) {
            pushReview(result, Object.assign({}, base, { resultType: profile === "SERIAL" ? "SERIALIZADO" : "NO SERIALIZADO" }),
              "La llave SAP + fecha + ID aparece " + indexes.removedCount.get(rKey) + " veces en Desmontados; PULSO usó la primera OT.");
          }
        });

        analysis = result;
        renderAnalysis();
        byId("processTitle").textContent = "Análisis completado";
        byId("processText").textContent = result.prealert.length + " prealertables · " + result.warranty.length + " garantías · " + result.review.length + " observaciones.";
        toast("Prealerta procesada correctamente.");
      } catch (error) {
        console.error(error);
        byId("processTitle").textContent = "No fue posible completar el análisis";
        byId("processText").textContent = error.message || "Revisa los archivos cargados.";
        toast("Error procesando prealerta.");
      } finally {
        button.disabled = false; button.textContent = "Procesar prealerta";
      }
    }, 40);
  }

  function resultCounts() {
    return analysis ? {
      control: analysis.stats.control,
      logytech: analysis.stats.logytech,
      prealert: analysis.prealert.length,
      warranty: analysis.warranty.length,
      excluded: analysis.excluded.length,
      review: analysis.review.length
    } : { control: 0, logytech: 0, prealert: 0, warranty: 0, excluded: 0, review: 0 };
  }

  function renderAnalysis() {
    if (!analysis) return;
    byId("resultSection").classList.remove("hidden");
    var c = resultCounts();

    byId("summaryCards").innerHTML =
      '<article class="prealert-kpi"><span>Retirados analizados</span><strong>' + c.control + '</strong><small>registros del control</small></article>' +
      '<article class="prealert-kpi"><span>Procesables Logytech</span><strong>' + c.logytech + '</strong><small>según maestro interno</small></article>' +
      '<article class="prealert-kpi success"><span>Prealertables</span><strong>' + c.prealert + '</strong><small>serializados + no serializados</small></article>' +
      '<article class="prealert-kpi warranty"><span>Garantías</span><strong>' + c.warranty + '</strong><small>designación Rechazado</small></article>' +
      '<article class="prealert-kpi review"><span>Revisión</span><strong>' + c.review + '</strong><small>observaciones visibles</small></article>';

    byId("tabCountPrealert").textContent = c.prealert;
    byId("tabCountWarranty").textContent = c.warranty;
    byId("tabCountExcluded").textContent = c.excluded;
    byId("tabCountReview").textContent = c.review;
    byId("generationDate").textContent = "Procesado " + new Date().toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });

    renderCityResults();
    renderResultTable();
    setTimeout(function () { byId("resultSection").scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
  }

  function renderCityResults() {
    var target = byId("cityResults");
    target.innerHTML = Object.keys(CITY_CONFIG).map(function (city) {
      var rows = analysis.cities[city];
      var total = rows.serialized.length + rows.nonSerialized.length;
      return '<article class="city-result-card">' +
        '<div class="city-card-head"><div><span class="city-kicker">CIUDAD</span><h4>' + escapeHtml(city) + '</h4></div><span class="city-warehouse">' + CITY_CONFIG[city].outputWarehouse + '</span></div>' +
        '<div class="city-counts">' +
          '<div><strong>' + rows.serialized.length + '</strong><span>Serializados</span></div>' +
          '<div><strong>' + rows.nonSerialized.length + '</strong><span>No serializados</span></div>' +
          '<div><strong>' + rows.warranty.length + '</strong><span>Garantías</span></div>' +
        '</div>' +
        '<div class="city-downloads">' +
          '<button class="primary-button city-download" type="button" data-report="prealert" data-city="' + city + '"' + (total + rows.warranty.length === 0 ? ' disabled' : '') + '>Descargar prealerta</button>' +
          '<button class="secondary-button city-download" type="button" data-report="warranty" data-city="' + city + '"' + (rows.warranty.length === 0 ? ' disabled' : '') + '>Descargar acta garantía</button>' +
        '</div>' +
      '</article>';
    }).join("");

    target.querySelectorAll(".city-download").forEach(function (button) {
      button.addEventListener("click", function () {
        var city = button.dataset.city;
        if (button.dataset.report === "prealert") generatePrealertWorkbook(city);
        else generateWarrantyWorkbook(city);
      });
    });
  }

  function bindResultTabs() {
    document.querySelectorAll(".result-tab").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".result-tab").forEach(function (x) { x.classList.remove("active"); });
        button.classList.add("active");
        activeResultTab = button.dataset.resultTab;
        renderResultTable();
      });
    });
    byId("resultSearch").addEventListener("input", renderResultTable);
  }

  function rowsForActiveTab() {
    if (!analysis) return [];
    if (activeResultTab === "warranty") return analysis.warranty;
    if (activeResultTab === "excluded") return analysis.excluded;
    if (activeResultTab === "review") return analysis.review;
    return analysis.prealert;
  }

  function renderResultTable() {
    var rows = rowsForActiveTab();
    var query = normalizeKey(byId("resultSearch").value);
    if (query) {
      rows = rows.filter(function (r) {
        return normalizeKey([r.city, r.resultType, r.sap, r.codeReported, r.serial, r.date, r.workOrder, r.iqWarehouse, r.reason].join(" ")).indexOf(query) >= 0;
      });
    }

    byId("resultTable").innerHTML = rows.map(function (r) {
      var typeClass = r.resultType === "GARANTIA" ? "warranty" : (r.resultType === "NO SERIALIZADO" ? "nonserial" : (r.resultType === "SERIALIZADO" ? "serial" : "neutral"));
      var resultText = activeResultTab === "excluded" || activeResultTab === "review" ? (r.reason || "Revisar") :
        (r.resultType === "GARANTIA" ? "Garantía" : "Prealertable");
      return "<tr>" +
        "<td><strong>" + escapeHtml(r.city || "—") + "</strong></td>" +
        '<td><span class="result-type ' + typeClass + '">' + escapeHtml(r.resultType || "—") + "</span></td>" +
        "<td>" + escapeHtml(r.codeReported || r.sap || "—") + "</td>" +
        '<td class="serial-cell">' + escapeHtml(r.serial || "—") + "</td>" +
        "<td>" + escapeHtml(dateLabel(r.date) || "—") + "</td>" +
        "<td>" + escapeHtml(r.workOrder || "—") + "</td>" +
        "<td>" + escapeHtml(r.iqWarehouse || "—") + "</td>" +
        "<td>" + escapeHtml(resultText) + "</td>" +
      "</tr>";
    }).join("");

    byId("resultEmpty").classList.toggle("hidden", rows.length > 0);
  }

  function excelBorder() {
    return {
      top: { style: "thin", color: { argb: "FF000000" } },
      left: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF000000" } }
    };
  }

  function stylePrealertHeader(cell) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC00000" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = excelBorder();
  }

  function styleDataCell(cell, center) {
    cell.font = { name: "Calibri", size: 10, color: { argb: "FF000000" } };
    cell.alignment = { horizontal: center ? "center" : "left", vertical: "middle", wrapText: false };
    cell.border = excelBorder();
  }

  function addNote(sheet, labelCell, textCell) {
    sheet.getCell(labelCell).value = "NOTA:";
    stylePrealertHeader(sheet.getCell(labelCell));
    sheet.getCell(textCell).value = "VALIDAR QUE NO EXISTAN SERIALES DUPLICADOS Y EL SERIAL DEBE ESTAR EN MAYUSCULA";
    sheet.getCell(textCell).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    sheet.getCell(textCell).font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF000000" } };
    sheet.getCell(textCell).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    sheet.getCell(textCell).border = excelBorder();
  }

  async function generatePrealertWorkbook(city) {
    if (!analysis || !analysis.cities[city]) return;
    if (!window.ExcelJS) { toast("No fue posible cargar el generador de Excel."); return; }

    var data = analysis.cities[city];
    var wb = new ExcelJS.Workbook();
    wb.creator = "PULSO";
    wb.created = new Date();

    var serial = wb.addWorksheet("SERIALIZADO");
    var serialHeaders = ["BODEGA SAP", "CODIGO REPORTADO", "FECHA DE RETIRADO", "ORDEN DE TRABAJO", "SERIAL REPORTADO"];
    serial.addRow(serialHeaders);
    serialHeaders.forEach(function (_, i) { stylePrealertHeader(serial.getCell(1, i + 1)); });
    serial.getRow(1).height = 30;
    serial.columns = [{ width: 10.4 }, { width: 16.6 }, { width: 16.3 }, { width: 15.7 }, { width: 24 }, { width: 2 }, { width: 2 }, { width: 9 }, { width: 68 }];
    addNote(serial, "H1", "I1");

    data.serialized.forEach(function (r) {
      var row = serial.addRow([r.outputWarehouse, r.codeReported, dateObject(r.date), r.workOrder, normalizeSerial(r.serial)]);
      for (var c = 1; c <= 5; c++) styleDataCell(row.getCell(c), true);
      row.getCell(3).numFmt = "dd/mm/yyyy";
      row.getCell(5).numFmt = "@";
    });

    var non = wb.addWorksheet("NOSERIALIZADO");
    var nonHeaders = ["CODIGO REPORTADO", "FECHA DE RETIRADO", "ORDEN DE TRABAJO", "CANTIDAD"];
    non.addRow(nonHeaders);
    nonHeaders.forEach(function (_, i) { stylePrealertHeader(non.getCell(1, i + 1)); });
    non.getRow(1).height = 30;
    non.columns = [{ width: 16.6 }, { width: 16.3 }, { width: 15.7 }, { width: 15.4 }];
    data.nonSerialized.forEach(function (r) {
      var row = non.addRow([r.codeReported, dateObject(r.date), r.workOrder, r.quantity]);
      for (var c = 1; c <= 4; c++) styleDataCell(row.getCell(c), true);
      row.getCell(2).numFmt = "dd/mm/yyyy";
    });

    var warranty = wb.addWorksheet("GARANTIA");
    var warrantyHeaders = ["BODEGA SAP", "CODIGO REPORTADO", "SERIAL REPORTADO"];
    warranty.addRow(warrantyHeaders);
    warrantyHeaders.forEach(function (_, i) { stylePrealertHeader(warranty.getCell(1, i + 1)); });
    warranty.getRow(1).height = 30;
    warranty.columns = [{ width: 10.4 }, { width: 16.6 }, { width: 23.9 }, { width: 2 }, { width: 2 }, { width: 9 }, { width: 68 }];
    addNote(warranty, "F1", "G1");
    data.warranty.forEach(function (r) {
      var row = warranty.addRow([r.outputWarehouse, r.codeReported, normalizeSerial(r.serial)]);
      for (var c = 1; c <= 3; c++) styleDataCell(row.getCell(c), true);
      row.getCell(3).numFmt = "@";
    });

    await downloadWorkbook(wb, "Prealerta Mintic " + city + " " + generationSuffix() + ".xlsx");
    toast("Prealerta de " + city + " generada.");
  }

  function rangeCells(ws, row, from, to, callback) {
    for (var c = from; c <= to; c++) callback(ws.getCell(row, c));
  }

  function mergeValue(ws, range, value, options) {
    ws.mergeCells(range);
    var cell = ws.getCell(range.split(":")[0]);
    cell.value = value;
    if (options && options.font) cell.font = options.font;
    if (options && options.fill) cell.fill = options.fill;
    cell.alignment = (options && options.alignment) || { horizontal: "center", vertical: "middle", wrapText: true };
  }

  function applyRangeBorder(ws, row, from, to, fill) {
    rangeCells(ws, row, from, to, function (cell) {
      cell.border = excelBorder();
      if (fill) cell.fill = fill;
    });
  }

  function makeClaroLogo() {
    var canvas = document.createElement("canvas");
    canvas.width = 420; canvas.height = 200;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var g = ctx.createRadialGradient(205, 72, 18, 210, 100, 165);
    g.addColorStop(0, "#ff7070"); g.addColorStop(.55, "#df161c"); g.addColorStop(1, "#7a0508");
    ctx.beginPath(); ctx.ellipse(210, 100, 190, 82, 0, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = "#801014"; ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 76px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Claro", 203, 104);
    ctx.lineWidth = 7; ctx.strokeStyle = "#ffffff";
    [[345,46,363,29],[359,70,385,68],[341,91,355,112]].forEach(function (p) {
      ctx.beginPath(); ctx.moveTo(p[0],p[1]); ctx.lineTo(p[2],p[3]); ctx.stroke();
    });
    return canvas.toDataURL("image/png");
  }

  function makeSignature() {
    var canvas = document.createElement("canvas");
    canvas.width = 1000; canvas.height = 140;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "72px Caveat, cursive";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("Evin Yesid Amaya Isenia", 20, 74);
    return canvas.toDataURL("image/png");
  }

  async function generateWarrantyWorkbook(city) {
    if (!analysis || !analysis.cities[city]) return;
    var warrantyRows = analysis.cities[city].warranty;
    if (!warrantyRows.length) { toast("No hay garantías para " + city + "."); return; }
    if (!window.ExcelJS) { toast("No fue posible cargar el generador de Excel."); return; }

    var config = CITY_CONFIG[city];
    var wb = new ExcelJS.Workbook();
    wb.creator = "PULSO";
    wb.created = new Date();
    var ws = wb.addWorksheet("Formato", {
      pageSetup: {
        orientation: "portrait",
        scale: 85,
        margins: { left: .17, right: .17, top: .24, bottom: .10, header: .10, footer: .10 }
      }
    });
    ws.views = [{ showGridLines: false }];

    for (var col = 1; col <= 37; col++) ws.getColumn(col).width = 3.0;
    ws.getColumn(1).width = 3.4;
    ws.getColumn(37).width = 3.4;

    var titleFont = { name: "Arial", size: 12, bold: true, color: { argb: "FF000000" } };
    var smallBold = { name: "Arial", size: 8, bold: true, color: { argb: "FF000000" } };
    var small = { name: "Arial", size: 8, color: { argb: "FF000000" } };
    var pale = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
    var gray = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };

    var logoId = wb.addImage({ base64: makeClaroLogo(), extension: "png" });
    ws.addImage(logoId, { tl: { col: 0.15, row: 1.1 }, ext: { width: 155, height: 72 } });

    mergeValue(ws, "H2:AE2", "FORMATO", { font: titleFont });
    mergeValue(ws, "H3:AE3", "REPORTE DE EQUIPOS Y MATERIALES DEFECTUOSOS", { font: titleFont });
    mergeValue(ws, "A4:AE4", "INFORMACIÓN PARA ANÁLISIS Y GARANTÍA DE EQUIPOS Y MATERIALES", { font: { name:"Arial",size:9,bold:true } });
    mergeValue(ws, "AF4:AK4", "VERSIÓN: 0", { font: smallBold });
    applyRangeBorder(ws, 2, 8, 31);
    applyRangeBorder(ws, 3, 8, 31);
    applyRangeBorder(ws, 4, 1, 37);

    mergeValue(ws, "A6:F6", "FECHA", { font: smallBold, fill: gray });
    mergeValue(ws, "H6:AE6", "ALIADO", { font: smallBold, fill: gray });
    mergeValue(ws, "AF6:AK6", "REGIONAL", { font: smallBold, fill: gray });
    applyRangeBorder(ws, 6, 1, 6, gray); applyRangeBorder(ws, 6, 8, 31, gray); applyRangeBorder(ws, 6, 32, 37, gray);

    var now = new Date();
    mergeValue(ws, "A7:B7", now.getDate(), { font: small });
    mergeValue(ws, "C7:D7", now.getMonth() + 1, { font: small });
    mergeValue(ws, "E7:F7", String(now.getFullYear()).slice(-2), { font: small });
    mergeValue(ws, "H7:AE7", "DOMINION " + city.toUpperCase() + " LOGISTICA", { font: smallBold });
    mergeValue(ws, "AF7:AK7", config.regional, { font: smallBold });
    applyRangeBorder(ws, 7, 1, 6); applyRangeBorder(ws, 7, 8, 31); applyRangeBorder(ws, 7, 32, 37);

    mergeValue(ws, "A9:AK9", "ORIGEN DE LA SOLICITUD", { font: smallBold, fill: pale });
    applyRangeBorder(ws, 9, 1, 37, pale);
    mergeValue(ws, "A10:H10", "PROYECTO", { font: smallBold });
    mergeValue(ws, "I10:M10", "IMPLEMENTACIÓN", { font: small });
    mergeValue(ws, "N10:P10", "", { font: small });
    mergeValue(ws, "Q10:W10", "MANTENIMIENTO", { font: small });
    mergeValue(ws, "X10:Z10", "", { font: small });
    mergeValue(ws, "AA10:AE10", "OPERACIÓN", { font: small });
    mergeValue(ws, "AF10:AK10", "", { font: small });
    applyRangeBorder(ws, 10, 1, 37);

    mergeValue(ws, "A11:H11", "TIPO", { font: smallBold });
    mergeValue(ws, "I11:M11", "CORRECTIVO", { font: small });
    mergeValue(ws, "N11:P11", "", { font: small });
    mergeValue(ws, "Q11:W11", "PREVENTIVO", { font: small });
    mergeValue(ws, "X11:Z11", "", { font: small });
    mergeValue(ws, "AA11:AE11", "OTRO", { font: small });
    mergeValue(ws, "AF11:AK11", "", { font: small });
    applyRangeBorder(ws, 11, 1, 37);

    mergeValue(ws, "A12:H12", "PROYECTO / OTRO", { font: smallBold });
    mergeValue(ws, "I12:M12", "OTRO", { font: small });
    mergeValue(ws, "N12:P12", "X", { font: {name:"Arial",size:10,bold:true} });
    mergeValue(ws, "Q12:AK12", "MINTIC", { font: smallBold });
    applyRangeBorder(ws, 12, 1, 37);

    mergeValue(ws, "A14:AK14", "RELACIONE LOS EQUIPOS Y/O MATERIALES PARA LOS CUALES SOLICITA GARANTÍA", { font: smallBold, fill: pale });
    applyRangeBorder(ws, 14, 1, 37, pale);

    mergeValue(ws, "A16:I17", "DESCRIPCIÓN EQUIPO Y/O MATERIAL", { font: smallBold, fill: gray });
    mergeValue(ws, "J16:M17", "CÓDIGO", { font: smallBold, fill: gray });
    mergeValue(ws, "N16:P17", "CANTIDAD", { font: smallBold, fill: gray });
    mergeValue(ws, "Q16:V17", "SERIAL", { font: smallBold, fill: gray });
    mergeValue(ws, "W16:Z17", "LOTE", { font: smallBold, fill: gray });
    mergeValue(ws, "AA16:AB17", "UM", { font: smallBold, fill: gray });
    mergeValue(ws, "AC16:AK17", "MOTIVO PARA SOLICITAR LA GARANTIA", { font: smallBold, fill: gray });
    for (var hr = 16; hr <= 17; hr++) applyRangeBorder(ws, hr, 1, 37, gray);

    var dataRows = Math.max(12, warrantyRows.length);
    for (var i = 0; i < dataRows; i++) {
      var rowNum = 18 + i;
      var item = warrantyRows[i] || null;
      ws.getRow(rowNum).height = 24;
      mergeValue(ws, "A" + rowNum + ":I" + rowNum, item ? (item.description || "") : "", { font: small, alignment:{horizontal:"left",vertical:"middle",wrapText:true} });
      mergeValue(ws, "J" + rowNum + ":M" + rowNum, item ? item.codeReported : "", { font: small });
      mergeValue(ws, "N" + rowNum + ":P" + rowNum, item ? 1 : "", { font: small });
      mergeValue(ws, "Q" + rowNum + ":V" + rowNum, item ? normalizeSerial(item.serial) : "", { font: small });
      mergeValue(ws, "W" + rowNum + ":Z" + rowNum, item ? (item.lot || "NOVALORADO") : "", { font: small });
      mergeValue(ws, "AA" + rowNum + ":AB" + rowNum, "", { font: small });
      mergeValue(ws, "AC" + rowNum + ":AK" + rowNum, item ? "EQUIPO NO PERMITE CONFIGURACION" : "", { font: small, alignment:{horizontal:"center",vertical:"middle",wrapText:true} });
      applyRangeBorder(ws, rowNum, 1, 37);
    }

    var conceptRow = 18 + dataRows;
    mergeValue(ws, "A" + conceptRow + ":AK" + conceptRow, "CONCEPTO TÉCNICO", { font: smallBold, fill: pale });
    applyRangeBorder(ws, conceptRow, 1, 37, pale);
    mergeValue(ws, "A" + (conceptRow + 1) + ":AK" + (conceptRow + 2), "", { font: small });
    applyRangeBorder(ws, conceptRow + 1, 1, 37); applyRangeBorder(ws, conceptRow + 2, 1, 37);

    var signTitle = conceptRow + 3;
    mergeValue(ws, "A" + signTitle + ":AK" + signTitle, "REGISTRO DE FIRMAS", { font: smallBold, fill: pale });
    applyRangeBorder(ws, signTitle, 1, 37, pale);

    var headRow = signTitle + 2;
    mergeValue(ws, "A" + headRow + ":S" + headRow, "SOLICITANTE", { font: smallBold, fill: gray });
    mergeValue(ws, "T" + headRow + ":AK" + headRow, "VERIFICADO POR", { font: smallBold, fill: gray });
    applyRangeBorder(ws, headRow, 1, 37, gray);

    var sigStart = headRow + 1;
    mergeValue(ws, "A" + sigStart + ":S" + (sigStart + 2), "", { font: small });
    mergeValue(ws, "T" + sigStart + ":AK" + (sigStart + 2), "", { font: small });
    for (var sr = sigStart; sr <= sigStart + 2; sr++) applyRangeBorder(ws, sr, 1, 37);

    var sigId = wb.addImage({ base64: makeSignature(), extension: "png" });
    ws.addImage(sigId, { tl: { col: 1.0, row: sigStart - 1 + .1 }, ext: { width: 360, height: 54 } });

    var nameRow = sigStart + 3;
    mergeValue(ws, "A" + nameRow + ":S" + nameRow, "EVIN YESID AMAYA ISENIA", { font: smallBold });
    mergeValue(ws, "T" + nameRow + ":AK" + nameRow, "", { font: small });
    applyRangeBorder(ws, nameRow, 1, 37);

    var roleRow = nameRow + 1;
    mergeValue(ws, "A" + roleRow + ":S" + roleRow, "ANALISTA LOGISTICO MINTIC", { font: smallBold });
    mergeValue(ws, "T" + roleRow + ":AK" + roleRow, "", { font: small });
    applyRangeBorder(ws, roleRow, 1, 37);

    ws.pageSetup.printArea = "A1:AK" + roleRow;
    ws.pageSetup.fitToPage = false;
    ws.properties.defaultRowHeight = 15;

    await downloadWorkbook(wb, "Acta Garantia Mintic " + city + " " + generationSuffix() + ".xlsx");
    toast("Acta de garantía de " + city + " generada.");
  }

  async function downloadWorkbook(workbook, fileName) {
    var buffer = await workbook.xlsx.writeBuffer();
    var blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  bindAuth();
  bindSources();
  bindResultTabs();
  refreshRunState();
  initSession();
})();