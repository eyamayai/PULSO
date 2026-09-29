(function () {
  "use strict";

  var STORAGE_KEY = "pulso_v01_data";
  var SESSION_KEY = "pulso_v01_session";

  var seed = {
    warehouses: [
      { id: "wh-rio-a221", center: "C903", code: "A221", name: "Riohacha A", organization: "Dominion", location: "Riohacha", type: "A", active: true },
      { id: "wh-rio-u020", center: "C903", code: "U020", name: "Riohacha U", organization: "Dominion", location: "Riohacha", type: "U", active: true }
    ],
    ingresos: [],
    movements: []
  };

  var data = loadData();

  function loadData() {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored && Array.isArray(stored.warehouses) && Array.isArray(stored.ingresos)) {
        if (!Array.isArray(stored.movements)) stored.movements = [];
        return stored;
      }
    } catch (e) {}
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return JSON.parse(JSON.stringify(seed));
  }

  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    renderAll();
  }

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
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(window.__pulsoToast);
    window.__pulsoToast = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  function nextIngresoCode() {
    var max = data.ingresos.reduce(function (acc, item) {
      var match = String(item.code || "").match(/(\d+)$/);
      return Math.max(acc, match ? Number(match[1]) : 0);
    }, 0);
    return "ING-" + String(max + 1).padStart(6, "0");
  }

  function setSession(user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ user: user, at: new Date().toISOString() }));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function showApp() {
    byId("loginView").classList.add("hidden");
    byId("appView").classList.remove("hidden");
    renderAll();
  }

  function showLogin() {
    byId("appView").classList.add("hidden");
    byId("loginView").classList.remove("hidden");
  }

  function initSession() {
    var remembered = localStorage.getItem("pulso_remember_user");
    if (remembered) {
      byId("loginUser").value = remembered;
      byId("rememberMe").checked = true;
    }
    if (sessionStorage.getItem(SESSION_KEY)) showApp();
  }

  byId("loginForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var user = byId("loginUser").value.trim();
    var password = byId("loginPassword").value;
    if (!user || !password) return;
    if (byId("rememberMe").checked) localStorage.setItem("pulso_remember_user", user);
    else localStorage.removeItem("pulso_remember_user");
    setSession(user);
    showApp();
    toast("PULSO está operando en modo local hasta conectar Supabase.");
  });

  byId("togglePassword").addEventListener("click", function () {
    var input = byId("loginPassword");
    input.type = input.type === "password" ? "text" : "password";
  });

  byId("forgotPassword").addEventListener("click", function () {
    toast("La recuperación de contraseña se activará con Supabase Auth.");
  });

  byId("logoutButton").addEventListener("click", function () {
    clearSession();
    showLogin();
  });

  document.querySelectorAll(".nav-item").forEach(function (button) {
    button.addEventListener("click", function () {
      document.querySelectorAll(".nav-item").forEach(function (x) { x.classList.remove("active"); });
      button.classList.add("active");
      document.querySelectorAll(".page").forEach(function (x) { x.classList.remove("active"); });
      byId("page-" + button.dataset.page).classList.add("active");
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
      byId("config-" + button.dataset.config).classList.add("active");
    });
  });

  document.querySelectorAll(".close-dialog").forEach(function (button) {
    button.addEventListener("click", function () {
      byId(button.dataset.close).close();
    });
  });

  function warehouseOptionsFor(location) {
    return data.warehouses
      .filter(function (w) { return w.active && (!location || w.location === location); })
      .map(function (w) {
        return '<option value="' + escapeHtml(w.code) + '">' + escapeHtml(w.code + " · " + w.name) + "</option>";
      }).join("");
  }

  function refreshDestinationWarehouses() {
    var form = byId("ingresoForm");
    var location = form.elements.destination.value;
    var select = byId("destinationWarehouse");
    var html = '<option value="">Selecciona...</option>' + warehouseOptionsFor(location);
    if (!data.warehouses.some(function (w) { return w.active && w.location === location; }) && location) {
      html += '<option value="PENDIENTE">Pendiente de configurar</option>';
    }
    select.innerHTML = html;
  }

  byId("ingresoForm").elements.destination.addEventListener("change", refreshDestinationWarehouses);

  byId("newIngresoButton").addEventListener("click", function () {
    var form = byId("ingresoForm");
    form.reset();
    form.elements.effectiveDate.value = new Date().toISOString().slice(0, 10);
    form.elements.recordOrigin.value = "OPERATIVO";
    form.elements.infoStatus.value = "COMPLETO";
    byId("itemsContainer").innerHTML = "";
    addItemRow();
    refreshDestinationWarehouses();
    byId("ingresoDialog").showModal();
  });

  byId("ingresoForm").elements.recordOrigin.addEventListener("change", function (event) {
    if (event.target.value === "HISTORICO") byId("ingresoForm").elements.infoStatus.value = "INCOMPLETO";
  });

  function addItemRow(values) {
    values = values || {};
    var row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML =
      '<div><label>Código SAP</label><input name="sapCode" value="' + escapeHtml(values.sapCode || "") + '" placeholder="Ej. 4060279" required></div>' +
      '<div><label>Serial</label><input name="serial" value="' + escapeHtml(values.serial || "") + '" placeholder="Vacío si no serializado"></div>' +
      '<div><label>Tipo recepción</label><select name="receptionType"><option>Nuevo</option><option>Remanufacturado</option></select></div>' +
      '<div><label>Lote</label><select name="lotType"><option>VALORADO</option><option>NOVALORADO</option></select></div>' +
      '<div><label>Cantidad</label><input name="quantity" type="number" min="1" value="' + escapeHtml(values.quantity || 1) + '" required></div>' +
      '<button type="button" class="remove-item" title="Eliminar línea">✕</button>';
    row.querySelector('[name="receptionType"]').value = values.receptionType || "Nuevo";
    row.querySelector('[name="lotType"]').value = values.lotType || "VALORADO";
    row.querySelector(".remove-item").addEventListener("click", function () {
      if (byId("itemsContainer").children.length > 1) row.remove();
      else toast("El ingreso debe conservar al menos una línea.");
    });
    byId("itemsContainer").appendChild(row);
  }

  byId("addItemButton").addEventListener("click", function () { addItemRow(); });

  byId("ingresoForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var items = Array.prototype.map.call(byId("itemsContainer").querySelectorAll(".item-row"), function (row) {
      return {
        sapCode: row.querySelector('[name="sapCode"]').value.trim().toUpperCase(),
        serial: row.querySelector('[name="serial"]').value.trim().toUpperCase(),
        receptionType: row.querySelector('[name="receptionType"]').value,
        lotType: row.querySelector('[name="lotType"]').value,
        quantity: Number(row.querySelector('[name="quantity"]').value || 1)
      };
    });

    var serials = items.map(function (x) { return x.serial; }).filter(Boolean);
    var duplicatedInSameIngreso = serials.some(function (serial, index) { return serials.indexOf(serial) !== index; });
    if (duplicatedInSameIngreso) {
      toast("Hay un serial repetido dentro del mismo ingreso.");
      return;
    }

    var ingreso = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      code: nextIngresoCode(),
      effectiveDate: form.elements.effectiveDate.value,
      recordOrigin: form.elements.recordOrigin.value,
      source: form.elements.source.value.trim(),
      sourceWarehouse: form.elements.sourceWarehouse.value.trim().toUpperCase(),
      destination: form.elements.destination.value,
      destinationWarehouse: form.elements.destinationWarehouse.value,
      sourceDocument: form.elements.sourceDocument.value.trim(),
      infoStatus: form.elements.infoStatus.value,
      notes: form.elements.notes.value.trim(),
      items: items,
      createdAt: new Date().toISOString()
    };

    data.ingresos.push(ingreso);
    items.forEach(function (item) {
      data.movements.push({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        movementType: "INGRESO",
        effectiveDate: ingreso.effectiveDate,
        receiptId: ingreso.id,
        receiptCode: ingreso.code,
        sapCode: item.sapCode,
        serial: item.serial,
        quantity: item.quantity,
        source: ingreso.source,
        sourceWarehouse: ingreso.sourceWarehouse,
        destination: ingreso.destination,
        destinationWarehouse: ingreso.destinationWarehouse,
        createdAt: ingreso.createdAt
      });
    });

    saveData();
    byId("ingresoDialog").close();
    toast("Ingreso " + ingreso.code + " registrado.");
  });

  byId("newWarehouseButton").addEventListener("click", function () {
    var form = byId("warehouseForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.active.value = "true";
    byId("warehouseDialog").showModal();
  });

  byId("warehouseForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var model = {
      id: form.elements.id.value || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      center: form.elements.center.value.trim().toUpperCase(),
      code: form.elements.code.value.trim().toUpperCase(),
      name: form.elements.name.value.trim(),
      organization: form.elements.organization.value.trim(),
      location: form.elements.location.value.trim(),
      type: form.elements.type.value,
      active: form.elements.active.value === "true"
    };

    var duplicate = data.warehouses.find(function (w) {
      return w.id !== model.id && w.center === model.center && w.code === model.code;
    });
    if (duplicate) {
      toast("Ya existe ese almacén dentro del mismo centro.");
      return;
    }

    var index = data.warehouses.findIndex(function (w) { return w.id === model.id; });
    if (index >= 0) data.warehouses[index] = model;
    else data.warehouses.push(model);
    saveData();
    byId("warehouseDialog").close();
    toast("Almacén SAP guardado.");
  });

  window.editWarehouse = function (id) {
    var warehouse = data.warehouses.find(function (w) { return w.id === id; });
    if (!warehouse) return;
    var form = byId("warehouseForm");
    Object.keys(warehouse).forEach(function (key) {
      if (form.elements[key]) form.elements[key].value = String(warehouse[key]);
    });
    byId("warehouseDialog").showModal();
  };

  window.removeWarehouse = function (id) {
    var warehouse = data.warehouses.find(function (w) { return w.id === id; });
    if (!warehouse) return;
    var used = data.ingresos.some(function (x) {
      return x.destinationWarehouse === warehouse.code || x.sourceWarehouse === warehouse.code;
    });
    if (used) {
      toast("No puede eliminarse: el almacén ya participa en movimientos. Desactívalo.");
      return;
    }
    if (!confirm("¿Eliminar " + warehouse.code + " de la configuración?")) return;
    data.warehouses = data.warehouses.filter(function (w) { return w.id !== id; });
    saveData();
    toast("Almacén eliminado.");
  };

  function renderWarehouses() {
    var tbody = byId("warehouseTable");
    tbody.innerHTML = data.warehouses.map(function (w) {
      return "<tr>" +
        "<td><strong>" + escapeHtml(w.center) + "</strong></td>" +
        "<td><strong>" + escapeHtml(w.code) + "</strong></td>" +
        "<td>" + escapeHtml(w.name) + "</td>" +
        "<td>" + escapeHtml(w.organization) + "</td>" +
        "<td>" + escapeHtml(w.location) + "</td>" +
        '<td><span class="badge gray">' + escapeHtml(w.type) + "</span></td>" +
        '<td><span class="badge ' + (w.active ? "green" : "gray") + '">' + (w.active ? "Activo" : "Inactivo") + "</span></td>" +
        '<td><button class="text-button" onclick="editWarehouse(\'' + w.id + '\')">Editar</button> <button class="text-button" onclick="removeWarehouse(\'' + w.id + '\')">Eliminar</button></td>' +
        "</tr>";
    }).join("");
  }

  function ingresoMatches(ingreso, query, type) {
    if (type && ingreso.recordOrigin !== type) return false;
    if (!query) return true;
    var haystack = [
      ingreso.code, ingreso.effectiveDate, ingreso.recordOrigin, ingreso.source,
      ingreso.sourceWarehouse, ingreso.destination, ingreso.destinationWarehouse,
      ingreso.sourceDocument,
      ingreso.items.map(function (x) { return x.sapCode + " " + x.serial; }).join(" ")
    ].join(" ").toLowerCase();
    return haystack.indexOf(query.toLowerCase()) >= 0;
  }

  function renderIngresos() {
    var query = byId("ingresosSearch").value.trim();
    var type = byId("ingresosFilter").value;
    var rows = data.ingresos
      .slice()
      .sort(function (a, b) { return String(b.effectiveDate).localeCompare(String(a.effectiveDate)); })
      .filter(function (x) { return ingresoMatches(x, query, type); });

    byId("ingresosTable").innerHTML = rows.map(function (x) {
      var typeBadge = x.recordOrigin === "HISTORICO" ? "orange" : (x.recordOrigin === "IMPORTACION" ? "gray" : "green");
      var statusBadge = x.infoStatus === "COMPLETO" ? "green" : "orange";
      return "<tr>" +
        "<td><strong>" + escapeHtml(x.code) + "</strong></td>" +
        "<td>" + escapeHtml(x.effectiveDate) + "</td>" +
        '<td><span class="badge ' + typeBadge + '">' + escapeHtml(x.recordOrigin) + "</span></td>" +
        "<td>" + escapeHtml(x.destination + " · " + x.destinationWarehouse) + "</td>" +
        "<td>" + escapeHtml(x.source || "Pendiente") + "</td>" +
        "<td>" + escapeHtml(x.sourceDocument || "No registrado") + "</td>" +
        "<td>" + x.items.length + "</td>" +
        '<td><span class="badge ' + statusBadge + '">' + escapeHtml(x.infoStatus) + "</span></td>" +
        "</tr>";
    }).join("");

    byId("ingresosEmpty").classList.toggle("hidden", rows.length > 0);
  }

  byId("ingresosSearch").addEventListener("input", renderIngresos);
  byId("ingresosFilter").addEventListener("change", renderIngresos);

  byId("traceButton").addEventListener("click", runTrace);
  byId("traceSerial").addEventListener("keydown", function (event) {
    if (event.key === "Enter") runTrace();
  });

  function runTrace() {
    var serial = byId("traceSerial").value.trim().toUpperCase();
    if (!serial) return;
    var moves = data.movements.filter(function (m) { return m.serial === serial; })
      .sort(function (a, b) { return String(a.effectiveDate).localeCompare(String(b.effectiveDate)); });
    var result = byId("traceResult");
    result.classList.remove("hidden");

    if (!moves.length) {
      result.innerHTML = '<div class="empty-state">No encontramos movimientos para el serial <strong>' + escapeHtml(serial) + "</strong>.</div>";
      return;
    }

    var sapCodes = Array.from(new Set(moves.map(function (m) { return m.sapCode; }))).join(", ");
    result.innerHTML =
      '<div class="trace-card-head"><div><span class="eyebrow">SERIAL</span><h3>' + escapeHtml(serial) + '</h3><p class="muted">Código(s) SAP: ' + escapeHtml(sapCodes) + "</p></div>" +
      '<span class="badge green">' + moves.length + " movimiento" + (moves.length === 1 ? "" : "s") + "</span></div>" +
      '<div class="timeline">' + moves.map(function (m, index) {
        return '<div class="timeline-item"><strong>' + (index + 1) + ". " + escapeHtml(m.movementType) + " · " + escapeHtml(m.receiptCode || "") + "</strong>" +
          "<span>" + escapeHtml((m.source || "Origen pendiente") + " → " + m.destination + " / " + m.destinationWarehouse) + "</span>" +
          "<small>Fecha efectiva: " + escapeHtml(m.effectiveDate) + "</small></div>";
      }).join("") + "</div>";
  }

  function renderRecent() {
    var target = byId("recentActivity");
    var recent = data.ingresos.slice().sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    }).slice(0, 5);
    if (!recent.length) {
      target.className = "empty-state";
      target.textContent = "Aún no hay movimientos. Registra el primer ingreso para comenzar la historia.";
      return;
    }
    target.className = "";
    target.innerHTML = recent.map(function (x) {
      return '<div class="activity-row"><span class="activity-icon">↘</span><div><strong>' +
        escapeHtml(x.code + " · " + x.destination + " / " + x.destinationWarehouse) +
        "</strong><small>" + escapeHtml(x.effectiveDate + " · " + x.items.length + " línea(s) · " + x.recordOrigin) +
        "</small></div></div>";
    }).join("");
  }

  function renderKpis() {
    byId("kpiIngresos").textContent = data.ingresos.length;
    var serials = new Set();
    data.ingresos.forEach(function (x) { x.items.forEach(function (item) { if (item.serial) serials.add(item.serial); }); });
    byId("kpiSeriales").textContent = serials.size;
    byId("kpiPendientes").textContent = data.ingresos.filter(function (x) { return x.infoStatus !== "COMPLETO"; }).length;
    byId("kpiAlmacenes").textContent = data.warehouses.filter(function (x) { return x.active; }).length;
  }

  function renderAll() {
    renderWarehouses();
    renderIngresos();
    renderRecent();
    renderKpis();
    refreshDestinationWarehouses();
  }

  renderAll();
  initSession();
})();