(function () {
  "use strict";

  var currentProfile = null;
  var masters = { warehouses: [], organizations: [] };
  var receipts = [];
  var importState = {
    fileName: "",
    rows: [],
    filter: "ALL",
    validating: false
  };

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toast(message) {
    var el = byId("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(window.__pulsoToast);
    window.__pulsoToast = setTimeout(function () { el.classList.remove("show"); }, 3000);
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeKey(value) {
    return normalizeText(value)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function formatDate(value) {
    if (!value) return "";
    var parts = String(value).slice(0, 10).split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : value;
  }

  function setFlowStep(step) {
    document.querySelectorAll(".flow-step").forEach(function (el) {
      var n = Number(el.dataset.flowStep || 0);
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
    });
  }

  function showApp() {
    byId("loginView").classList.add("hidden");
    byId("appView").classList.remove("hidden");
    if (currentProfile) {
      byId("logoutButton").textContent = (currentProfile.display_name || "P").charAt(0).toUpperCase();
      byId("logoutButton").title = (currentProfile.display_name || "Usuario") + " · " + currentProfile.role + " · Cerrar sesión";
    }
    loadOperationalData();
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
      showLogin();
      toast("No fue posible inicializar la conexión segura con Supabase.");
      return;
    }

    try {
      var session = await window.PULSO_BACKEND.getSession();
      if (session && session.user) {
        currentProfile = await window.PULSO_BACKEND.ensureProfile(session.user);
        if (!currentProfile.active) {
          await window.PULSO_BACKEND.signOut();
          currentProfile = null;
          showLogin();
          toast("Tu usuario está inactivo en PULSO.");
          return;
        }
        showApp();
      } else {
        showLogin();
      }
    } catch (error) {
      console.error(error);
      showLogin();
      toast("No fue posible validar la sesión.");
    }
  }

  async function loadOperationalData() {
    try {
      var result = await Promise.all([
        window.PULSO_BACKEND.getReceiptMasters(),
        window.PULSO_BACKEND.listReceipts(200)
      ]);
      masters = result[0];
      receipts = result[1];
      populateIngresoMasters();
      renderReceipts();
      renderDashboard();
      renderWarehouses();
    } catch (error) {
      console.error(error);
      toast("No fue posible cargar los datos operativos.");
    }
  }

  function bindNavigation() {
    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".nav-item").forEach(function (x) { x.classList.remove("active"); });
        button.classList.add("active");
        document.querySelectorAll(".page").forEach(function (x) { x.classList.remove("active"); });
        var page = byId("page-" + button.dataset.page);
        if (page) page.classList.add("active");
        document.querySelector(".sidebar").classList.remove("open");
      });
    });

    byId("menuButton").addEventListener("click", function () {
      document.querySelector(".sidebar").classList.toggle("open");
    });

    document.querySelectorAll(".config-tab").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".config-tab").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".config-panel").forEach(function (x) { x.classList.remove("active"); });
        button.classList.add("active");
        var panel = byId("config-" + button.dataset.config);
        if (panel) panel.classList.add("active");
      });
    });

    document.querySelectorAll(".close-dialog").forEach(function (button) {
      button.addEventListener("click", function () {
        var dialog = byId(button.dataset.close);
        if (dialog) dialog.close();
      });
    });
  }

  function bindLogin() {
    byId("loginForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      var user = byId("loginUser").value.trim();
      var password = byId("loginPassword").value;
      var submit = event.currentTarget.querySelector('button[type="submit"]');
      if (!user || !password) return;

      if (byId("rememberMe").checked) localStorage.setItem("pulso_remember_user", user);
      else localStorage.removeItem("pulso_remember_user");

      submit.disabled = true;
      submit.innerHTML = 'Validando acceso...';

      try {
        var auth = await window.PULSO_BACKEND.signIn(user, password);
        currentProfile = await window.PULSO_BACKEND.ensureProfile(auth.user);
        if (!currentProfile.active) {
          await window.PULSO_BACKEND.signOut();
          currentProfile = null;
          throw new Error("Usuario inactivo");
        }
        showApp();
        toast("Acceso confirmado · " + currentProfile.role);
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

    byId("forgotPassword").addEventListener("click", function () {
      toast("La recuperación de contraseña se habilitará en una siguiente iteración.");
    });

    var corporate = byId("corporateAccess");
    if (corporate) corporate.addEventListener("click", function () {
      toast("El acceso corporativo quedará disponible cuando se defina el proveedor SSO.");
    });

    byId("logoutButton").addEventListener("click", async function () {
      try { await window.PULSO_BACKEND.signOut(); } catch (error) { console.error(error); }
      currentProfile = null;
      showLogin();
    });
  }

  function warehouseShape(row) {
    return {
      id: row.id,
      code: row.code || "",
      name: row.name || "",
      type: row.warehouse_type || "",
      active: row.active !== false,
      center: row.center && row.center.code ? row.center.code : "",
      centerName: row.center && row.center.name ? row.center.name : "",
      location: row.location && row.location.name ? row.location.name : "",
      organization: row.organization && row.organization.name ? row.organization.name : ""
    };
  }

  function populateIngresoMasters() {
    var form = byId("ingresoWorkspaceForm");
    if (!form) return;

    var warehouses = (masters.warehouses || []).map(warehouseShape);
    var locations = unique(warehouses.map(function (w) { return w.location; })).sort();
    byId("ingresoDestination").innerHTML =
      '<option value="">Selecciona...</option>' +
      locations.map(function (x) { return '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>'; }).join("");

    byId("sourceWarehouses").innerHTML = warehouses.map(function (w) {
      return '<option value="' + escapeHtml(w.code) + '">' + escapeHtml(w.center + " · " + w.name + " · " + w.location) + '</option>';
    }).join("");

    byId("sourceOrganizations").innerHTML = (masters.organizations || []).map(function (o) {
      return '<option value="' + escapeHtml(o.name) + '"></option>';
    }).join("");

    refreshDestinationWarehouses();
  }

  function refreshDestinationWarehouses() {
    var location = byId("ingresoDestination").value;
    var select = byId("ingresoDestinationWarehouse");
    var warehouses = (masters.warehouses || []).map(warehouseShape).filter(function (w) {
      return w.active && (!location || w.location === location);
    });
    select.innerHTML = '<option value="">' + (location ? "Selecciona..." : "Selecciona ubicación primero...") + '</option>' +
      warehouses.map(function (w) {
        return '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.center + " · " + w.code + " · " + w.name) + '</option>';
      }).join("");
  }

  function resetIngresoWorkspace(keepHeader) {
    var form = byId("ingresoWorkspaceForm");
    if (!keepHeader) {
      form.reset();
      form.elements.effectiveDate.value = new Date().toISOString().slice(0, 10);
      form.elements.recordOrigin.value = "OPERATIVO";
      form.elements.infoStatus.value = "COMPLETO";
      refreshDestinationWarehouses();
    }
    importState.fileName = "";
    importState.rows = [];
    importState.filter = "ALL";
    byId("ingresoFileInput").value = "";
    byId("ingresoFileName").textContent = "Aún no has cargado un archivo";
    byId("ingresoFileMeta").innerHTML = 'La plantilla contiene las hojas <b>Serializados</b> y <b>No Serializados</b>.';
    byId("ingresoValidationPanel").classList.add("hidden");
    byId("exportIngresoIssues").classList.add("hidden");
    byId("processIngresoButton").disabled = true;
    document.querySelectorAll(".preview-tab").forEach(function (x) { x.classList.remove("active"); });
    document.querySelector('.preview-tab[data-preview-filter="ALL"]').classList.add("active");
    updateHeaderStatus();
    setFlowStep(1);
  }

  function updateHeaderStatus() {
    var form = byId("ingresoWorkspaceForm");
    var required = ["effectiveDate", "recordOrigin", "destination", "destinationWarehouseId"];
    var complete = required.every(function (name) { return normalizeText(form.elements[name].value); });
    var badge = byId("ingresoHeaderStatus");
    badge.textContent = complete ? "Cabecera lista" : "Pendiente";
    badge.classList.toggle("ready", complete);
    if (complete && !importState.rows.length) setFlowStep(2);
    return complete;
  }

  function bindIngresoHeader() {
    var form = byId("ingresoWorkspaceForm");
    form.addEventListener("input", updateHeaderStatus);
    form.addEventListener("change", updateHeaderStatus);

    byId("ingresoDestination").addEventListener("change", function () {
      refreshDestinationWarehouses();
      updateHeaderStatus();
    });

    form.elements.recordOrigin.addEventListener("change", function () {
      if (form.elements.recordOrigin.value === "HISTORICO" && form.elements.infoStatus.value === "COMPLETO") {
        form.elements.infoStatus.value = "INCOMPLETO";
      }
      updateHeaderStatus();
    });

    byId("newIngresoButton").addEventListener("click", function () {
      resetIngresoWorkspace(false);
      toast("Ingreso limpio. Puedes comenzar una nueva recepción.");
    });
  }

  function makeTemplate() {
    if (!window.XLSX) {
      toast("No fue posible cargar el componente de Excel.");
      return;
    }

    var workbook = XLSX.utils.book_new();

    var serializados = [
      ["Código SAP", "Serial", "Tipo de Recepción", "Lote"]
    ];
    var noSerializados = [
      ["Código SAP", "Cantidad", "Tipo de Recepción", "Lote"]
    ];
    var instrucciones = [
      ["PULSO · Plantilla de Ingresos", ""],
      ["Hoja", "Uso"],
      ["Serializados", "Una fila por equipo. El serial es obligatorio y la cantidad siempre es 1."],
      ["No Serializados", "Una fila por material. Diligencia la cantidad total recibida."],
      ["", ""],
      ["Campo", "Valores / regla"],
      ["Código SAP", "Obligatorio. Debe corresponder al material recibido."],
      ["Serial", "Solo en Serializados. No repetir seriales dentro del mismo archivo."],
      ["Cantidad", "Solo en No Serializados. Debe ser mayor a cero."],
      ["Tipo de Recepción", "Nuevo | Remanufacturado"],
      ["Lote", "VALORADO | NOVALORADO"],
      ["", ""],
      ["Importante", "Los datos de cabecera (fecha, origen, destino y documento) se diligencian directamente en PULSO, no se repiten en el Excel."]
    ];

    var s1 = XLSX.utils.aoa_to_sheet(serializados);
    var s2 = XLSX.utils.aoa_to_sheet(noSerializados);
    var s3 = XLSX.utils.aoa_to_sheet(instrucciones);

    s1["!cols"] = [{wch:16},{wch:28},{wch:22},{wch:18}];
    s2["!cols"] = [{wch:16},{wch:12},{wch:22},{wch:18}];
    s3["!cols"] = [{wch:24},{wch:88}];

    XLSX.utils.book_append_sheet(workbook, s1, "Serializados");
    XLSX.utils.book_append_sheet(workbook, s2, "No Serializados");
    XLSX.utils.book_append_sheet(workbook, s3, "Instrucciones");

    XLSX.writeFile(workbook, "PULSO_Plantilla_Ingreso.xlsx");
    toast("Plantilla de ingreso generada.");
  }

  function findSheet(workbook, wanted) {
    var target = normalizeKey(wanted);
    var name = workbook.SheetNames.find(function (n) { return normalizeKey(n) === target; });
    return name ? workbook.Sheets[name] : null;
  }

  function headerMap(row) {
    var map = {};
    Object.keys(row || {}).forEach(function (key) { map[normalizeKey(key)] = row[key]; });
    return map;
  }

  function getCell(row, names) {
    var mapped = headerMap(row);
    for (var i = 0; i < names.length; i++) {
      var key = normalizeKey(names[i]);
      if (Object.prototype.hasOwnProperty.call(mapped, key)) return mapped[key];
    }
    return "";
  }

  function sheetRows(sheet, type) {
    if (!sheet) return [];
    var json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    return json.map(function (raw, index) {
      var sapCode = normalizeText(getCell(raw, ["Código SAP","Codigo SAP","SAP","Material"])).toUpperCase();
      var serial = type === "SERIAL" ? normalizeText(getCell(raw, ["Serial","Número de Serie","Numero de Serie"])).toUpperCase() : "";
      var quantityRaw = type === "SERIAL" ? 1 : getCell(raw, ["Cantidad","Cant","Cantidad Ingresada"]);
      var quantity = Number(String(quantityRaw || "").replace(",", "."));
      var receptionRaw = normalizeText(getCell(raw, ["Tipo de Recepción","Tipo Recepción","Tipo de Recepcion","Tipo Recepcion"]));
      var receptionKey = normalizeKey(receptionRaw);
      var receptionType = receptionKey === "nuevo" ? "Nuevo" : (receptionKey === "remanufacturado" ? "Remanufacturado" : receptionRaw);
      var lotType = normalizeText(getCell(raw, ["Lote","Tipo de Lote"])).toUpperCase();

      return {
        sheet: type === "SERIAL" ? "Serializados" : "No Serializados",
        excelRow: index + 2,
        sapCode: sapCode,
        serial: serial,
        quantity: type === "SERIAL" ? 1 : quantity,
        receptionType: receptionType,
        lotType: lotType,
        sourceType: type,
        description: "",
        severity: "OK",
        messages: []
      };
    }).filter(function (r) {
      return r.sapCode || r.serial || (r.sourceType === "NONSERIAL" && r.quantity);
    });
  }

  function addIssue(row, severity, message) {
    var rank = { OK:0, WARNING:1, ERROR:2 };
    if (rank[severity] > rank[row.severity]) row.severity = severity;
    if (row.messages.indexOf(message) < 0) row.messages.push(message);
  }

  async function validateImportedRows(rows) {
    importState.validating = true;
    setFlowStep(3);

    var sapCodes = unique(rows.map(function (r) { return r.sapCode; }));
    var serials = unique(rows.map(function (r) { return r.serial; }));

    var lookup = await Promise.all([
      window.PULSO_BACKEND.findMaterials(sapCodes),
      window.PULSO_BACKEND.findEquipment(serials)
    ]);

    var materials = {};
    lookup[0].forEach(function (m) { materials[String(m.sap_code).toUpperCase()] = m; });

    var equipment = {};
    lookup[1].forEach(function (e) { equipment[String(e.serial).toUpperCase()] = e; });

    var serialCounts = {};
    var sapTypes = {};
    rows.forEach(function (r) {
      if (r.serial) serialCounts[r.serial] = (serialCounts[r.serial] || 0) + 1;
      if (r.sapCode) {
        if (!sapTypes[r.sapCode]) sapTypes[r.sapCode] = {};
        sapTypes[r.sapCode][r.sourceType] = true;
      }
    });

    rows.forEach(function (row) {
      row.severity = "OK";
      row.messages = [];

      if (!row.sapCode) addIssue(row, "ERROR", "Código SAP obligatorio.");

      if (row.sourceType === "SERIAL") {
        if (!row.serial) addIssue(row, "ERROR", "Serial obligatorio.");
        if (row.serial && serialCounts[row.serial] > 1) addIssue(row, "ERROR", "Serial repetido dentro del archivo.");
        row.quantity = 1;
      } else {
        if (!Number.isFinite(row.quantity) || row.quantity <= 0) addIssue(row, "ERROR", "Cantidad inválida.");
      }

      if (["Nuevo","Remanufacturado"].indexOf(row.receptionType) < 0) {
        addIssue(row, "ERROR", "Tipo de recepción debe ser Nuevo o Remanufacturado.");
      }

      if (["VALORADO","NOVALORADO"].indexOf(row.lotType) < 0) {
        addIssue(row, "ERROR", "Lote debe ser VALORADO o NOVALORADO.");
      }

      var material = materials[row.sapCode];
      if (row.sapCode && sapTypes[row.sapCode] && sapTypes[row.sapCode].SERIAL && sapTypes[row.sapCode].NONSERIAL) {
        addIssue(row, "ERROR", "El mismo Código SAP aparece como serializado y no serializado en el archivo.");
      }
      if (!material && row.sapCode) {
        row.description = "Pendiente de maestra";
        addIssue(row, "WARNING", "Código SAP no existe en la maestra; se creará pendiente de completar.");
      } else if (material) {
        row.description = material.description || "";
        if (!material.active) addIssue(row, "ERROR", "Material inactivo en la maestra.");
        if (row.sourceType === "SERIAL" && material.serialized === false) {
          addIssue(row, "ERROR", "El material está configurado como no serializado.");
        }
        if (row.sourceType === "NONSERIAL" && material.serialized === true) {
          addIssue(row, "ERROR", "El material exige serial individual.");
        }
      }

      if (row.serial && equipment[row.serial]) {
        var eq = equipment[row.serial];
        var existingSap = eq.material && eq.material.sap_code ? String(eq.material.sap_code).toUpperCase() : "";
        if (existingSap && row.sapCode && existingSap !== row.sapCode) {
          addIssue(row, "ERROR", "El serial ya existe asociado al Código SAP " + existingSap + ".");
        } else if (String(eq.current_status || "").toUpperCase() === "DISPONIBLE") {
          var place = eq.warehouse && eq.warehouse.code ? eq.warehouse.code : "otra ubicación";
          addIssue(row, "ERROR", "El serial ya figura DISPONIBLE en " + place + ". Registra primero su salida.");
        } else {
          addIssue(row, "WARNING", "Serial existente. Se tratará como reingreso; último estado: " + (eq.current_status || "sin determinar") + ".");
        }
      }

      if (!row.messages.length) row.messages.push("Sin novedades.");
    });

    importState.rows = rows;
    importState.validating = false;
    renderValidation();
  }

  async function readIngresoFile(file) {
    if (!file) return;
    if (!window.XLSX) {
      toast("No fue posible cargar el componente de Excel.");
      return;
    }

    try {
      byId("ingresoFileName").textContent = "Analizando " + file.name + "...";
      byId("ingresoFileMeta").textContent = "Leyendo hojas y validando información.";
      byId("ingresoValidationPanel").classList.remove("hidden");
      setFlowStep(3);

      var buffer = await file.arrayBuffer();
      var workbook = XLSX.read(buffer, { type: "array" });
      var serialSheet = findSheet(workbook, "Serializados");
      var nonSerialSheet = findSheet(workbook, "No Serializados");

      if (!serialSheet && !nonSerialSheet) {
        throw new Error("El archivo debe contener las hojas Serializados y/o No Serializados.");
      }

      var rows = sheetRows(serialSheet, "SERIAL").concat(sheetRows(nonSerialSheet, "NONSERIAL"));
      if (!rows.length) throw new Error("No se encontraron líneas diligenciadas en la plantilla.");

      importState.fileName = file.name;
      byId("ingresoFileName").textContent = file.name;
      byId("ingresoFileMeta").textContent = rows.length + " línea(s) detectadas. Validando contra PULSO...";

      await validateImportedRows(rows);
    } catch (error) {
      console.error(error);
      importState.rows = [];
      byId("ingresoFileName").textContent = file.name;
      byId("ingresoFileMeta").textContent = error.message || "No fue posible leer el archivo.";
      byId("ingresoValidationPanel").classList.add("hidden");
      setFlowStep(updateHeaderStatus() ? 2 : 1);
      toast(error.message || "Archivo de ingreso inválido.");
    }
  }

  function validationCounts() {
    var counts = { total: importState.rows.length, OK:0, WARNING:0, ERROR:0 };
    importState.rows.forEach(function (r) { counts[r.severity] = (counts[r.severity] || 0) + 1; });
    return counts;
  }

  function renderValidation() {
    var counts = validationCounts();
    byId("validationTotal").textContent = counts.total;
    byId("validationOk").textContent = counts.OK;
    byId("validationWarnings").textContent = counts.WARNING;
    byId("validationErrors").textContent = counts.ERROR;

    var filter = importState.filter;
    var visible = importState.rows.filter(function (r) { return filter === "ALL" || r.severity === filter; });
    byId("ingresoPreviewTable").innerHTML = visible.map(function (r) {
      var badge = r.severity === "ERROR" ? "error" : (r.severity === "WARNING" ? "warning" : "ok");
      var label = r.severity === "ERROR" ? "Error" : (r.severity === "WARNING" ? "Advertencia" : "Correcto");
      return "<tr>" +
        "<td>" + escapeHtml(r.sheet) + "</td>" +
        "<td>" + escapeHtml(r.excelRow) + "</td>" +
        "<td><strong>" + escapeHtml(r.sapCode || "—") + "</strong></td>" +
        "<td>" + escapeHtml(r.description || "—") + "</td>" +
        "<td>" + escapeHtml(r.serial || "—") + "</td>" +
        "<td>" + escapeHtml(r.quantity || "—") + "</td>" +
        "<td>" + escapeHtml(r.receptionType || "—") + "</td>" +
        "<td>" + escapeHtml(r.lotType || "—") + "</td>" +
        '<td><span class="validation-badge ' + badge + '">' + label + "</span></td>" +
        "<td>" + escapeHtml(r.messages.join(" ")) + "</td>" +
      "</tr>";
    }).join("");

    var hasIssues = counts.ERROR + counts.WARNING > 0;
    byId("exportIngresoIssues").classList.toggle("hidden", !hasIssues);

    var processButton = byId("processIngresoButton");
    var headerOk = updateHeaderStatus();
    processButton.disabled = !headerOk || counts.total === 0 || counts.ERROR > 0;

    if (counts.ERROR > 0) {
      byId("processStatusTitle").textContent = "Corrige " + counts.ERROR + " error(es) antes de procesar";
      byId("processStatusText").textContent = "Los errores bloquean el ingreso. Puedes exportar las inconsistencias.";
      setFlowStep(3);
    } else if (!headerOk) {
      byId("processStatusTitle").textContent = "Completa la cabecera del ingreso";
      byId("processStatusText").textContent = "Fecha, tipo de registro, ubicación y almacén destino son obligatorios.";
      setFlowStep(1);
    } else if (counts.WARNING > 0) {
      byId("processStatusTitle").textContent = "Archivo procesable con " + counts.WARNING + " advertencia(s)";
      byId("processStatusText").textContent = "Revisa las advertencias. No bloquean el ingreso.";
      setFlowStep(4);
    } else {
      byId("processStatusTitle").textContent = "Todo está listo para registrar";
      byId("processStatusText").textContent = counts.total + " línea(s) sin conflictos.";
      setFlowStep(4);
    }

    byId("ingresoFileMeta").textContent =
      counts.total + " línea(s): " + counts.OK + " correctas · " + counts.WARNING + " advertencias · " + counts.ERROR + " errores.";
  }

  function exportIssues() {
    if (!window.XLSX) return;
    var rows = importState.rows.filter(function (r) { return r.severity !== "OK"; });
    if (!rows.length) return;
    var data = rows.map(function (r) {
      return {
        Hoja:r.sheet,
        Fila:r.excelRow,
        "Código SAP":r.sapCode,
        Serial:r.serial,
        Cantidad:r.quantity,
        "Tipo de Recepción":r.receptionType,
        Lote:r.lotType,
        Estado:r.severity === "ERROR" ? "Error" : "Advertencia",
        Motivo:r.messages.join(" ")
      };
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{wch:18},{wch:8},{wch:16},{wch:28},{wch:12},{wch:22},{wch:18},{wch:14},{wch:80}];
    XLSX.utils.book_append_sheet(wb, ws, "Inconsistencias");
    XLSX.writeFile(wb, "PULSO_Inconsistencias_" + new Date().toISOString().slice(0,10) + ".xlsx");
  }

  function headerPayload() {
    var form = byId("ingresoWorkspaceForm");
    return {
      effectiveDate: form.elements.effectiveDate.value,
      recordOrigin: form.elements.recordOrigin.value,
      source: normalizeText(form.elements.source.value),
      sourceWarehouse: normalizeText(form.elements.sourceWarehouse.value).toUpperCase(),
      destination: form.elements.destination.value,
      destinationWarehouseId: form.elements.destinationWarehouseId.value,
      sourceDocument: normalizeText(form.elements.sourceDocument.value),
      infoStatus: form.elements.infoStatus.value,
      notes: normalizeText(form.elements.notes.value)
    };
  }

  async function processIngreso() {
    var counts = validationCounts();
    if (!updateHeaderStatus() || !counts.total || counts.ERROR) return;

    if (counts.WARNING && !window.confirm("Hay " + counts.WARNING + " advertencia(s). ¿Deseas procesar el ingreso de todas formas?")) return;

    var button = byId("processIngresoButton");
    button.disabled = true;
    button.textContent = "Procesando...";

    try {
      var payload = headerPayload();
      payload.items = importState.rows.map(function (r) {
        return {
          sapCode:r.sapCode,
          serial:r.serial,
          quantity:r.quantity,
          receptionType:r.receptionType,
          lotType:r.lotType
        };
      });

      await window.PULSO_BACKEND.createReceipt(payload);
      toast("Ingreso registrado correctamente en PULSO.");
      resetIngresoWorkspace(false);
      receipts = await window.PULSO_BACKEND.listReceipts(200);
      renderReceipts();
      renderDashboard();
      setFlowStep(1);
    } catch (error) {
      console.error(error);
      toast("No fue posible procesar el ingreso: " + (error.message || "error no identificado"));
      renderValidation();
    } finally {
      button.textContent = "Procesar ingreso";
      if (!importState.rows.length) button.disabled = true;
    }
  }

  function bindIngresoImport() {
    byId("downloadIngresoTemplate").addEventListener("click", makeTemplate);
    byId("uploadIngresoButton").addEventListener("click", function () { byId("ingresoFileInput").click(); });
    byId("ingresoFileInput").addEventListener("change", function (event) { readIngresoFile(event.target.files[0]); });

    var drop = byId("ingresoDropzone");
    ["dragenter","dragover"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add("dragging");
      });
    });
    ["dragleave","drop"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.remove("dragging");
      });
    });
    drop.addEventListener("drop", function (event) {
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readIngresoFile(file);
    });

    document.querySelectorAll(".preview-tab").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".preview-tab").forEach(function (x) { x.classList.remove("active"); });
        button.classList.add("active");
        importState.filter = button.dataset.previewFilter;
        renderValidation();
      });
    });

    byId("exportIngresoIssues").addEventListener("click", exportIssues);
    byId("processIngresoButton").addEventListener("click", processIngreso);
  }

  function receiptView(row) {
    var destination = row.destination_warehouse || {};
    var location = destination.location && destination.location.name ? destination.location.name : "";
    var source = row.source_organization && row.source_organization.name ? row.source_organization.name : "Pendiente";
    return {
      id:row.id,
      code:row.pulso_code,
      effectiveDate:row.effective_date,
      recordOrigin:row.record_origin,
      infoStatus:row.info_status,
      sourceDocument:row.source_document || "",
      source:source,
      destination:location,
      destinationWarehouse:destination.code || "",
      itemCount:Array.isArray(row.items) ? row.items.length : 0,
      items:Array.isArray(row.items) ? row.items : []
    };
  }

  function receiptMatches(row, query, type) {
    if (type && row.recordOrigin !== type) return false;
    if (!query) return true;
    return [
      row.code,row.effectiveDate,row.recordOrigin,row.source,row.destination,row.destinationWarehouse,row.sourceDocument
    ].join(" ").toLowerCase().indexOf(query.toLowerCase()) >= 0;
  }

  function renderReceipts() {
    var search = byId("ingresosSearch");
    var filter = byId("ingresosFilter");
    if (!search || !filter) return;
    var query = search.value.trim();
    var type = filter.value;
    var rows = receipts.map(receiptView).filter(function (x) { return receiptMatches(x, query, type); });

    byId("ingresosTable").innerHTML = rows.map(function (x) {
      var typeBadge = x.recordOrigin === "HISTORICO" ? "orange" : (x.recordOrigin === "IMPORTACION" ? "gray" : "green");
      var statusBadge = x.infoStatus === "COMPLETO" ? "green" : "orange";
      return "<tr>" +
        "<td><strong>" + escapeHtml(x.code) + "</strong></td>" +
        "<td>" + escapeHtml(formatDate(x.effectiveDate)) + "</td>" +
        '<td><span class="badge ' + typeBadge + '">' + escapeHtml(x.recordOrigin) + "</span></td>" +
        "<td>" + escapeHtml((x.destination || "—") + " · " + (x.destinationWarehouse || "—")) + "</td>" +
        "<td>" + escapeHtml(x.source) + "</td>" +
        "<td>" + escapeHtml(x.sourceDocument || "No registrado") + "</td>" +
        "<td>" + x.itemCount + "</td>" +
        '<td><span class="badge ' + statusBadge + '">' + escapeHtml(x.infoStatus) + "</span></td>" +
      "</tr>";
    }).join("");
    byId("ingresosEmpty").classList.toggle("hidden", rows.length > 0);
  }

  function renderDashboard() {
    var views = receipts.map(receiptView);
    byId("kpiIngresos").textContent = views.length;
    var serials = new Set();
    views.forEach(function (r) {
      r.items.forEach(function (i) { if (i.serial_snapshot) serials.add(i.serial_snapshot); });
    });
    byId("kpiSeriales").textContent = serials.size;
    byId("kpiPendientes").textContent = views.filter(function (x) { return x.infoStatus !== "COMPLETO"; }).length;
    byId("kpiAlmacenes").textContent = (masters.warehouses || []).filter(function (x) { return x.active !== false; }).length;

    var target = byId("recentActivity");
    var recent = views.slice(0, 5);
    if (!recent.length) {
      target.className = "empty-state";
      target.textContent = "Aún no hay movimientos. Registra el primer ingreso para comenzar la historia.";
      return;
    }
    target.className = "";
    target.innerHTML = recent.map(function (x) {
      return '<div class="activity-row"><span class="activity-icon">↘</span><div><strong>' +
        escapeHtml(x.code + " · " + (x.destination || "Destino") + " / " + x.destinationWarehouse) +
        "</strong><small>" + escapeHtml(formatDate(x.effectiveDate) + " · " + x.itemCount + " línea(s) · " + x.recordOrigin) +
        "</small></div></div>";
    }).join("");
  }

  async function runTrace() {
    var serial = normalizeText(byId("traceSerial").value).toUpperCase();
    if (!serial) return;

    var result = byId("traceResult");
    result.classList.remove("hidden");
    result.innerHTML = '<div class="empty-state">Consultando trazabilidad...</div>';

    try {
      var equipment = await window.PULSO_BACKEND.findEquipment([serial]);
      if (!equipment.length) {
        result.innerHTML = '<div class="empty-state">No encontramos el serial <strong>' + escapeHtml(serial) + '</strong> en PULSO.</div>';
        return;
      }

      var eq = equipment[0];
      var moves = await window.PULSO_BACKEND.client
        .from("movement_items")
        .select("id,quantity,status_after,movement:movements(movement_type,effective_at,pulso_code,source_document,source_warehouse:sap_warehouses!movements_source_warehouse_id_fkey(code,name),destination_warehouse:sap_warehouses!movements_destination_warehouse_id_fkey(code,name))")
        .eq("equipment_id", eq.id);

      if (moves.error) throw moves.error;
      var rows = (moves.data || []).sort(function (a,b) {
        return String(a.movement && a.movement.effective_at || "").localeCompare(String(b.movement && b.movement.effective_at || ""));
      });

      result.innerHTML =
        '<div class="trace-card-head"><div><span class="eyebrow">SERIAL</span><h3>' + escapeHtml(serial) + '</h3><p class="muted">Código SAP: ' +
        escapeHtml(eq.material && eq.material.sap_code || "—") + '</p></div><span class="badge green">' +
        escapeHtml(eq.current_status || "SIN ESTADO") + '</span></div>' +
        '<div class="timeline">' +
        rows.map(function (row,index) {
          var m = row.movement || {};
          var src = m.source_warehouse && m.source_warehouse.code ? m.source_warehouse.code : "Origen";
          var dst = m.destination_warehouse && m.destination_warehouse.code ? m.destination_warehouse.code : "Destino";
          return '<div class="timeline-item"><strong>' + (index+1) + '. ' + escapeHtml(m.movement_type || "MOVIMIENTO") + ' · ' + escapeHtml(m.pulso_code || "") +
            '</strong><span>' + escapeHtml(src + " → " + dst) + '</span><small>Fecha efectiva: ' +
            escapeHtml(formatDate(m.effective_at)) + '</small></div>';
        }).join("") +
        '</div>';
    } catch (error) {
      console.error(error);
      result.innerHTML = '<div class="empty-state">No fue posible consultar la trazabilidad.</div>';
    }
  }

  function renderWarehouses() {
    var tbody = byId("warehouseTable");
    if (!tbody) return;
    var rows = (masters.warehouses || []).map(warehouseShape);
    tbody.innerHTML = rows.map(function (w) {
      return "<tr>" +
        "<td><strong>" + escapeHtml(w.center) + "</strong></td>" +
        "<td><strong>" + escapeHtml(w.code) + "</strong></td>" +
        "<td>" + escapeHtml(w.name) + "</td>" +
        "<td>" + escapeHtml(w.organization || "—") + "</td>" +
        "<td>" + escapeHtml(w.location || "—") + "</td>" +
        '<td><span class="badge gray">' + escapeHtml(w.type) + "</span></td>" +
        '<td><span class="badge ' + (w.active ? "green" : "gray") + '">' + (w.active ? "Activo" : "Inactivo") + "</span></td>" +
        '<td><span class="table-note">Supabase</span></td>' +
      "</tr>";
    }).join("");
  }

  function bindSecondaryModules() {
    byId("ingresosSearch").addEventListener("input", renderReceipts);
    byId("ingresosFilter").addEventListener("change", renderReceipts);

    byId("traceButton").addEventListener("click", runTrace);
    byId("traceSerial").addEventListener("keydown", function (event) {
      if (event.key === "Enter") runTrace();
    });

    var addWarehouse = byId("newWarehouseButton");
    if (addWarehouse) addWarehouse.addEventListener("click", function () {
      toast("El CRUD completo de Almacenes SAP será conectado a Supabase en Configuración.");
    });

    var warehouseForm = byId("warehouseForm");
    if (warehouseForm) warehouseForm.addEventListener("submit", function (event) {
      event.preventDefault();
      toast("Edición de Almacenes SAP pendiente de conectar en esta iteración.");
      byId("warehouseDialog").close();
    });
  }

  function initIngreso() {
    resetIngresoWorkspace(false);
    bindIngresoHeader();
    bindIngresoImport();
  }

  bindLogin();
  bindNavigation();
  bindSecondaryModules();
  initIngreso();
  initSession();
})();