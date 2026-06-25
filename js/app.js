const STORAGE_KEY = "latoto-dashboard-data";
const DATA_URL = "data/schedule.json";
const FIREBASE_DEFAULT_PATH = "latoto-dashboard";
const BASE_TEMPLATE_VERSION = "manual-empty-v1";
const JOBDESK_ACTIVE_SHIFTS = ["Pagi", "Malam"];
let currentJobdeskShift = "Pagi";
let currentScheduleGroup = "SHIFT KAPTEN-KASIR";
let currentHistoryMonthKey = "";
let staffSettingDraft = [];
let firebaseDatabase = null;
let firebaseDataRef = null;
let firebaseRealtimeStarted = false;
let firebaseInitialSnapshotHandled = false;
let lastSavedDataSignature = "";
let pendingFirebaseSaveTimer = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const page = document.body.dataset.page;

  try {
    const data = await loadData();

    if (page === "dashboard") {
      renderDashboard(data);
    }

    if (page === "jobdesk") {
      renderJobdeskPage(data);
    }
  } catch (error) {
    renderLoadError(error);
  }
});

async function loadData() {
  const response = await fetch(DATA_URL);

  if (!response.ok) {
    throw new Error("Gagal membaca file JSON.");
  }

  const initialData = prepareInitialTemplate(await response.json());
  const savedData = localStorage.getItem(STORAGE_KEY);
  const firebaseData = await loadFirebaseData(initialData);

  if (firebaseData) {
    startFirebaseRealtimeSync(initialData);
    return firebaseData;
  }

  if (!savedData) {
    persistLocalData(initialData);
    return initialData;
  }

  try {
    const persistedData = getSafePersistedData(initialData, JSON.parse(savedData));
    const normalizedData = normalizeData(persistedData);
    persistLocalData(normalizedData);
    return normalizedData;
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
    persistLocalData(initialData);
    return initialData;
  }
}

function saveData(data) {
  syncDerivedOffdayCounts(data);
  const normalizedData = normalizeData(data);
  persistLocalData(normalizedData);
  queueFirebaseSave(normalizedData);
}

function mergePersistedData(initialData, savedData) {
  return {
    ...initialData,
    ...savedData,
    staff: Array.isArray(savedData?.staff) ? savedData.staff : initialData.staff || [],
    jobdeskBoard: Array.isArray(savedData?.jobdeskBoard) ? savedData.jobdeskBoard : initialData.jobdeskBoard || [],
    jobdeskOptions: Array.isArray(savedData?.jobdeskOptions) ? savedData.jobdeskOptions : initialData.jobdeskOptions || []
  };
}

function prepareInitialTemplate(sourceData) {
  const baseData = normalizeData({
    ...sourceData,
    baseTemplateVersion: BASE_TEMPLATE_VERSION,
    staff: [],
    jobdeskBoard: normalizeJobdeskBoard([], sourceData?.jobdeskOptions || [])
  });

  return baseData;
}

function getSafePersistedData(initialData, savedData) {
  if (!savedData || savedData.baseTemplateVersion !== initialData.baseTemplateVersion) {
    return cloneData(initialData);
  }

  return mergePersistedData(initialData, savedData);
}

function persistLocalData(data) {
  const clonedData = cloneData(data);
  lastSavedDataSignature = createDataSignature(clonedData);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clonedData));
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function createDataSignature(data) {
  return JSON.stringify(data);
}

async function loadFirebaseData(initialData) {
  const database = initializeFirebaseDatabase();

  if (!database) {
    return null;
  }

  try {
    const snapshot = await database.ref(getFirebaseDataPath()).once("value");

    if (!snapshot.exists()) {
      const seededData = cloneData(initialData);
      await database.ref(getFirebaseDataPath()).set(seededData);
      persistLocalData(seededData);
      return seededData;
    }

    const remoteSnapshotData = snapshot.val();

    if (!remoteSnapshotData || remoteSnapshotData.baseTemplateVersion !== initialData.baseTemplateVersion) {
      const seededData = cloneData(initialData);
      await database.ref(getFirebaseDataPath()).set(seededData);
      persistLocalData(seededData);
      return seededData;
    }

    const remoteData = getSafePersistedData(initialData, remoteSnapshotData);
    const normalizedRemoteData = normalizeData(remoteData);
    persistLocalData(normalizedRemoteData);
    return normalizedRemoteData;
  } catch (error) {
    console.error("Firebase load gagal, memakai localStorage.", error);
    return null;
  }
}

function initializeFirebaseDatabase() {
  if (firebaseDatabase) {
    return firebaseDatabase;
  }

  const config = window.LATOTO_FIREBASE_CONFIG;
  const firebaseApp = window.firebase;

  if (!config || !config.apiKey || !firebaseApp?.initializeApp || !firebaseApp?.database) {
    return null;
  }

  if (!firebaseApp.apps.length) {
    firebaseApp.initializeApp(config);
  }

  firebaseDatabase = firebaseApp.database();
  firebaseDataRef = firebaseDatabase.ref(getFirebaseDataPath());
  return firebaseDatabase;
}

function getFirebaseDataPath() {
  return window.LATOTO_FIREBASE_PATH || FIREBASE_DEFAULT_PATH;
}

function queueFirebaseSave(data) {
  if (!firebaseDataRef) {
    return;
  }

  const nextPayload = cloneData(data);

  window.clearTimeout(pendingFirebaseSaveTimer);
  pendingFirebaseSaveTimer = window.setTimeout(() => {
    firebaseDataRef.set(nextPayload).catch((error) => {
      console.error("Firebase save gagal.", error);
    });
  }, 120);
}

function startFirebaseRealtimeSync(initialData) {
  if (!firebaseDataRef || firebaseRealtimeStarted) {
    return;
  }

  firebaseRealtimeStarted = true;

  firebaseDataRef.on("value", (snapshot) => {
    if (!firebaseInitialSnapshotHandled) {
      firebaseInitialSnapshotHandled = true;
      return;
    }

    if (!snapshot.exists()) {
      return;
    }

    const nextData = normalizeData(getSafePersistedData(initialData, snapshot.val()));
    const nextSignature = createDataSignature(nextData);

    if (nextSignature === lastSavedDataSignature) {
      return;
    }

    persistLocalData(nextData);
    window.location.reload();
  });
}

function normalizeData(data) {
  const currentMonthKey = getMonthKey();

  data.jobdeskOptions = normalizeJobdeskOptions(data.jobdeskOptions, data.jobdeskBoard);
  data.jobdeskBoard = normalizeJobdeskBoard(data.jobdeskBoard, data.jobdeskOptions);

  data.staff = (data.staff || []).map((item) => {
    const normalizedStaff = normalizeStaffOffdayState(item, currentMonthKey);

    return {
      ...normalizedStaff,
      offdayUsed: getMonthlyOffdayTotal(normalizedStaff, currentMonthKey)
    };
  });

  return data;
}

function syncDerivedOffdayCounts(data) {
  const currentMonthKey = getMonthKey();

  data.jobdeskOptions = normalizeJobdeskOptions(data.jobdeskOptions, data.jobdeskBoard);
  data.jobdeskBoard = normalizeJobdeskBoard(data.jobdeskBoard, data.jobdeskOptions);

  data.staff = (data.staff || []).map((item) => {
    const normalizedStaff = normalizeStaffOffdayState(item, currentMonthKey);

    return {
      ...normalizedStaff,
      offdayUsed: getMonthlyOffdayTotal(normalizedStaff, currentMonthKey)
    };
  });
}

function renderDashboard(data) {
  const staff = data.staff || [];
  const csStaff = staff.filter((item) => item.group === "SHIFT CS");
  const kkStaff = staff.filter((item) => item.group === "SHIFT KAPTEN-KASIR");
  const stats = getStats(staff, data.maxOffdayPerMonth || 2);

  setText("hero-title", `${staff.length} staff aktif dipantau hari ini`);
  setText(
    "hero-summary",
    staff.length === 0
      ? "Belum ada staff yang diinput. Tambahkan data staff manual dari Dashboard Jobdesk untuk mulai memakai dashboard ini."
      : `Total OFF DAY bulan ini ${stats.totalOffdaysUsed} kali dengan sisa kuota ${stats.totalRemaining}. ${stats.overallStatusText}.`
  );

  renderStats(stats);
  renderShiftTable("cs-table-body", csStaff, data.maxOffdayPerMonth || 2);
  renderShiftTable("kk-table-body", kkStaff, data.maxOffdayPerMonth || 2);
  renderWarnings("warning-list", staff, data.maxOffdayPerMonth || 2);
  bindHistoryModal(data);
  startRealtimeDisplay();
}

function renderJobdeskPage(data) {
  const scheduleStaff = getScheduleStaffByGroup(data, currentScheduleGroup);

  refreshStaffSelectors(data);
  populateOffdayStaffSelect(data.staff);
  populateJobdeskSelect(data.jobdeskBoard);
  initCustomSelects();

  hydrateScheduleForm(data);
  hydrateJobdeskForm(data);

  renderScheduleTable(data, scheduleStaff);
  renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);

  bindAddStaffForm(data);
  bindScheduleForm(data);
  bindJobdeskForm(data);
  bindInlineJobdeskTable(data);
  bindScheduleGroupSwitch(data);
  bindJobdeskShiftSwitch(data);
  bindFocusAddStaffButton();
  bindFocusStaffSettingButton(data);
  bindAddStaffModal();
  bindStaffSettingModal(data);
  bindFocusOffdayButton(data);
  bindOffdayModal();
  bindOffdayForm(data);
  bindResetJobdeskBoard(data);
  bindResetButton(data);
}

function getStats(staff, maxOffday) {
  const currentMonthKey = getMonthKey();
  const totalOffdaysUsed = staff.reduce((total, item) => total + getMonthlyOffdayTotal(item, currentMonthKey), 0);
  const totalRemaining = staff.reduce((total, item) => total + Math.max(maxOffday - getMonthlyOffdayTotal(item, currentMonthKey), 0), 0);
  const warningCount = staff.filter((item) => getMonthlyOffdayTotal(item, currentMonthKey) >= maxOffday).length;
  const nearLimitCount = staff.filter((item) => getMonthlyOffdayTotal(item, currentMonthKey) === maxOffday - 1).length;
  const overallStatusText = warningCount > 0 ? "Ada staff yang sudah mencapai batas OFF DAY." : "Semua staff masih dalam batas aman.";
  const overallLabel = totalRemaining > 0 ? "Aman" : "Habis";

  return {
    totalStaff: staff.length,
    totalOffdaysUsed,
    totalRemaining,
    warningCount,
    nearLimitCount,
    overallStatusText,
    overallLabel
  };
}

function renderStats(stats) {
  const container = document.getElementById("stats-grid");
  if (!container) {
    return;
  }

  const cards = [
    {
      title: "Total Staff Aktif",
      value: String(stats.totalStaff),
      note: "CS dan Kapten-Kasir"
    },
    {
      title: "Status OFF DAY Sisa",
      value: String(stats.totalRemaining),
      note: "Sisa kuota OFF DAY seluruh staff"
    },
    {
      title: "OFF DAY Bulan Ini",
      value: String(stats.totalOffdaysUsed),
      note: `Status total: ${stats.overallLabel}`
    },
    {
      title: "Peringatan Max 2x",
      value: String(stats.warningCount),
      note: `${stats.nearLimitCount} staff mendekati batas`
    }
  ];

  container.innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card">
          <p>${card.title}</p>
          <strong>${card.value}</strong>
          <span class="muted">${card.note}</span>
        </article>
      `
    )
    .join("");
}

function renderShiftTable(targetId, rows, maxOffday) {
  const body = document.getElementById(targetId);
  if (!body) {
    return;
  }

  const todayKey = getTodayKey();

  if (!rows.length) {
    body.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">Belum ada data staff pada panel ini.</div>
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = sortStaffByShift(rows)
    .map((item) => {
      const monthlyStatus = getOffdayStatus(getMonthlyOffdayTotal(item), maxOffday);
      const dutyStatus = getDutyStatus(item, todayKey);

      return `
        <tr>
          <td>${item.name}</td>
          <td>${item.role}</td>
          <td>${item.shift}</td>
          <td>${formatHoursDisplay(item.hours)}</td>
          <td>
            <span class="status-pill ${monthlyStatus.className}">${monthlyStatus.label}</span>
            <small>${getMonthlyOffdayTotal(item)}/${maxOffday}</small>
          </td>
          <td><span class="status-pill ${dutyStatus.className}">${dutyStatus.label}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderWarnings(targetId, staff, maxOffday) {
  const container = document.getElementById(targetId);
  if (!container) {
    return;
  }

  const recentMonthKeys = getRecentMonthKeys(6);
  const currentMonthKey = recentMonthKeys[0];

  const sortedStaff = [...staff].sort((left, right) => {
    const statusWeight = {
      "Peringatan: batas habis": 0,
      "Waspada: sisa 1": 1,
      Aman: 2
    };
    const leftStatus = getOffdayStatus(getMonthlyOffdayTotal(left, currentMonthKey), maxOffday);
    const rightStatus = getOffdayStatus(getMonthlyOffdayTotal(right, currentMonthKey), maxOffday);
    const leftWeight = statusWeight[leftStatus.label] ?? 9;
    const rightWeight = statusWeight[rightStatus.label] ?? 9;

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight;
    }

    return left.name.localeCompare(right.name, "id");
  });

  const safeCount = sortedStaff.filter((item) => getMonthlyOffdayTotal(item, currentMonthKey) === 0).length;
  const warningCount = sortedStaff.filter((item) => getMonthlyOffdayTotal(item, currentMonthKey) === maxOffday - 1).length;
  const dangerCount = sortedStaff.filter((item) => getMonthlyOffdayTotal(item, currentMonthKey) >= maxOffday).length;
  const monitoringContent =
    sortedStaff.length === 0
      ? `
        <div class="empty-state">Belum ada data staff untuk dimonitor. Tambahkan staff terlebih dahulu dari Dashboard Jobdesk.</div>
      `
      : sortedStaff
          .map((item) => {
            const total = getMonthlyOffdayTotal(item, currentMonthKey);
            const remaining = Math.max(maxOffday - total, 0);
            const status = getOffdayStatus(total, maxOffday);
            const dutyStatus = getDutyStatus(item);
            const usagePercent = Math.min((total / maxOffday) * 100, 100);
            const currentSlots = getOffdaySlotsForMonth(item, currentMonthKey);

            return `
              <article class="warning-item">
                <div class="warning-top">
                  <div>
                    <strong>${item.name}</strong>
                    <span class="warning-subtitle">${item.group} • ${item.role}</span>
                  </div>
                  <span class="status-pill ${dutyStatus.className}">${dutyStatus.label}</span>
                </div>
                <div class="warning-meta">
                  <span class="status-pill ${status.className}">${status.label}</span>
                  <span class="warning-count">${total}/${maxOffday} OFF DAY</span>
                  <span class="warning-count">Sisa ${remaining}</span>
                </div>
                <div class="warning-progress">
                  <div class="warning-progress-bar warning-progress-${status.className.replace("status-", "")}" style="width: ${usagePercent}%"></div>
                </div>
                <div class="warning-dates">
                  <span>${formatOffdaySlotLabel(currentSlots[0], 1)}</span>
                  <span>${formatOffdaySlotLabel(currentSlots[1], 2)}</span>
                </div>
                <div class="warning-footer">
                  <span>Shift: ${item.shift}</span>
                  <span>Jam: ${formatHoursDisplay(item.hours)}</span>
                  <span>Status hari ini: ${dutyStatus.label}</span>
                </div>
              </article>
            `;
          })
          .join("");

  container.innerHTML = `
    <div class="monitoring-summary">
      <article class="monitoring-stat monitoring-stat-safe">
        <span class="monitoring-stat-label">Aman</span>
        <strong>${safeCount}</strong>
        <small>Staff masih punya jatah penuh</small>
      </article>
      <article class="monitoring-stat monitoring-stat-warning">
        <span class="monitoring-stat-label">Waspada</span>
        <strong>${warningCount}</strong>
        <small>Staff tersisa 1 OFF DAY</small>
      </article>
      <article class="monitoring-stat monitoring-stat-danger">
        <span class="monitoring-stat-label">Peringatan</span>
        <strong>${dangerCount}</strong>
        <small>Staff sudah mencapai batas</small>
      </article>
    </div>
    <div class="monitoring-grid">
      ${monitoringContent}
    </div>
  `;
}

function bindHistoryModal(data) {
  const modal = document.getElementById("history-modal");
  const openButton = document.getElementById("open-history-modal");
  const closeButton = document.getElementById("close-history-modal");
  const monthSelect = document.getElementById("history-month-select");

  if (!modal || !openButton || !closeButton || !monthSelect) {
    return;
  }

  populateHistoryMonthSelect(monthSelect);
  renderHistoryModal(data, currentHistoryMonthKey, data.maxOffdayPerMonth || 2);

  openButton.onclick = () => {
    populateHistoryMonthSelect(monthSelect);
    renderHistoryModal(data, currentHistoryMonthKey, data.maxOffdayPerMonth || 2);
    openHistoryModal();
  };

  closeButton.onclick = () => {
    closeHistoryModal();
  };

  modal.onclick = (event) => {
    if (event.target === modal) {
      closeHistoryModal();
    }
  };

  monthSelect.onchange = (event) => {
    currentHistoryMonthKey = event.target.value;
    renderHistoryModal(data, currentHistoryMonthKey, data.maxOffdayPerMonth || 2);
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeHistoryModal();
    }
  });
}

function populateHistoryMonthSelect(select) {
  const historyMonthKeys = getRecentMonthKeys(7).slice(1, 7);

  if (!currentHistoryMonthKey || !historyMonthKeys.includes(currentHistoryMonthKey)) {
    currentHistoryMonthKey = historyMonthKeys[0] || "";
  }

  select.innerHTML = historyMonthKeys
    .map((monthKey, index) => `<option value="${monthKey}">${index + 1} Bulan Lalu - ${formatHistoryMonthLabel(monthKey)}</option>`)
    .join("");

  if (currentHistoryMonthKey) {
    select.value = currentHistoryMonthKey;
  }
}

function renderHistoryModal(data, monthKey, maxOffday) {
  const container = document.getElementById("history-modal-body");

  if (!container || !monthKey) {
    return;
  }

  const staff = [...(data.staff || [])].sort((left, right) => {
    const totalDifference = getMonthlyOffdayTotal(right, monthKey) - getMonthlyOffdayTotal(left, monthKey);

    if (totalDifference !== 0) {
      return totalDifference;
    }

    return left.name.localeCompare(right.name, "id");
  });
  const monthLabel = formatHistoryMonthLabel(monthKey);
  const staffWithOffday = staff.filter((item) => getMonthlyOffdayTotal(item, monthKey) > 0).length;
  const totalOffdayEntries = staff.reduce((total, item) => total + getMonthlyOffdayTotal(item, monthKey), 0);
  const historyStaff = staff.filter((item) => getMonthlyOffdayTotal(item, monthKey) > 0);
  const historyContent =
    historyStaff.length === 0
      ? `
        <div class="history-empty-state">
          <strong>Tidak ada history OFF DAY pada ${monthLabel}</strong>
          <span>Pilih bulan lain dari 1-6 bulan ke belakang untuk melihat tanggal OFF DAY ke-1 dan ke-2.</span>
        </div>
      `
      : `
        <div class="history-modal-grid">
          ${historyStaff
            .map((item) => {
              const total = getMonthlyOffdayTotal(item, monthKey);
              const remaining = Math.max(maxOffday - total, 0);
              const status = getOffdayStatus(total, maxOffday);
              const slots = getOffdaySlotsForMonth(item, monthKey);

              return `
                <article class="history-modal-item">
                  <div class="history-modal-item-head">
                    <div>
                      <strong>${item.name}</strong>
                      <span>${item.group} • ${item.role}</span>
                    </div>
                    <span class="status-pill ${status.className}">${status.label}</span>
                  </div>
                  <div class="history-modal-item-meta">
                    <span>Total ${total}/${maxOffday}</span>
                    <span>Sisa ${remaining}</span>
                    <span>Shift ${item.shift}</span>
                  </div>
                  <div class="history-modal-slots">
                    <div class="history-modal-slot">
                      <small>OFF DAY ke-1</small>
                      <strong>${getSlotValueLabel(slots[0])}</strong>
                      <span>${getSlotDetailLabel(slots[0], 1)}</span>
                    </div>
                    <div class="history-modal-slot">
                      <small>OFF DAY ke-2</small>
                      <strong>${getSlotValueLabel(slots[1])}</strong>
                      <span>${getSlotDetailLabel(slots[1], 2)}</span>
                    </div>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
      `;

  container.innerHTML = `
    <div class="history-modal-summary">
      <article class="history-modal-stat">
        <span class="history-modal-label">Periode</span>
        <strong>${monthLabel}</strong>
        <small>History OFF DAY bulan yang dipilih</small>
      </article>
      <article class="history-modal-stat">
        <span class="history-modal-label">Staff Dengan OFF DAY</span>
        <strong>${staffWithOffday}</strong>
        <small>Dari total ${staff.length} staff aktif</small>
      </article>
      <article class="history-modal-stat">
        <span class="history-modal-label">Total OFF DAY</span>
        <strong>${totalOffdayEntries}</strong>
        <small>Reset otomatis, history maksimal 6 bulan</small>
      </article>
    </div>
    ${historyContent}
  `;
}

function renderScheduleTable(data, rows) {
  const body = document.getElementById("schedule-table-body");
  if (!body) {
    return;
  }

  if (!rows.length) {
    body.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state">Belum ada staff pada grup ini. Tambahkan staff terlebih dahulu.</div>
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = sortStaffByShift(rows)
    .map(
      (item) => `
        <tr>
          <td>${item.name}</td>
          <td>${item.role}</td>
          <td>${item.shift}</td>
          <td>${formatHoursDisplay(item.hours)}</td>
          <td>${getMonthlyOffdayTotal(item)}/${data.maxOffdayPerMonth}</td>
        </tr>
      `
    )
    .join("");
}

function renderJobdeskTable(jobdeskBoard, shiftFilter) {
  const body = document.getElementById("jobdesk-table-body");
  if (!body) {
    return;
  }

  const filteredBoard = jobdeskBoard.filter((item) => item.shift === shiftFilter && item.assignedTo?.trim());
  const uniqueJobdeskNames = [...new Set((jobdeskBoard || []).map((item) => item.jobdesk).filter(Boolean))];

  if (filteredBoard.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="2">
          <div class="empty-state">Belum ada data jobdesk untuk SHIFT ${shiftFilter.toUpperCase()}.</div>
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = filteredBoard
    .map(
      (item) => `
        <tr>
          <td>${item.assignedTo}</td>
          <td>
            <select
              class="js-custom-select table-jobdesk-select"
              data-current-jobdesk="${escapeHtml(item.jobdesk)}"
              data-shift="${escapeHtml(item.shift)}"
              data-custom-wrapper-class="table-jobdesk-select-wrap"
              data-custom-trigger-class="jobdesk-badge ${getJobdeskToneClass(item.jobdesk, uniqueJobdeskNames)}"
            >
              ${uniqueJobdeskNames
                .map(
                  (jobdeskName) => `
                    <option value="${escapeHtml(jobdeskName)}" ${jobdeskName === item.jobdesk ? "selected" : ""}>
                      ${escapeHtml(jobdeskName)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </td>
        </tr>
      `
    )
    .join("");

  initCustomSelects();
}

function bindScheduleForm(data) {
  const form = document.getElementById("schedule-form");
  const staffSelect = document.getElementById("schedule-staff");
  const startTimeInput = document.getElementById("schedule-start-time");
  const endTimeInput = document.getElementById("schedule-end-time");

  if (!form || !staffSelect || !startTimeInput || !endTimeInput) {
    return;
  }

  staffSelect.addEventListener("change", () => {
    hydrateScheduleForm(data);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const staffId = staffSelect.value;
    const staff = data.staff.find((item) => item.id === staffId);

    if (!staff) {
      return;
    }

    staff.shift = document.getElementById("schedule-shift").value;
    staff.hours = formatWorkHours(startTimeInput.value, endTimeInput.value);

    if (!staff.hours) {
      return;
    }

    saveData(data);
    renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
  });
}

function bindJobdeskForm(data) {
  const form = document.getElementById("jobdesk-form");
  const jobdeskSelect = document.getElementById("jobdesk-id");
  const assignedSelect = document.getElementById("jobdesk-assigned");
  const shiftSelect = document.getElementById("jobdesk-shift");

  if (!form || !jobdeskSelect || !assignedSelect || !shiftSelect) {
    return;
  }

  jobdeskSelect.addEventListener("change", () => {
    hydrateJobdeskForm(data);
  });

  shiftSelect.addEventListener("change", () => {
    hydrateJobdeskForm(data);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const jobdesk = getJobdeskAssignment(data.jobdeskBoard, jobdeskSelect.value, shiftSelect.value);

    if (!jobdesk) {
      return;
    }

    jobdesk.assignedTo = assignedSelect.value;
    jobdesk.shift = normalizeJobdeskShift(shiftSelect.value);

    saveData(data);
    renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);
  });
}

function bindInlineJobdeskTable(data) {
  const tableBody = document.getElementById("jobdesk-table-body");

  if (!tableBody) {
    return;
  }

  if (tableBody.dataset.inlineBound === "true") {
    return;
  }

  tableBody.dataset.inlineBound = "true";

  tableBody.addEventListener("change", (event) => {
    const select = event.target.closest(".table-jobdesk-select");

    if (!select) {
      return;
    }

    const currentJobdesk = select.dataset.currentJobdesk || "";
    const nextJobdesk = select.value;
    const shift = normalizeJobdeskShift(select.dataset.shift || currentJobdeskShift);

    if (!currentJobdesk || !nextJobdesk || currentJobdesk === nextJobdesk) {
      return;
    }

    swapJobdeskAssignmentNames(data, currentJobdesk, nextJobdesk, shift);
    saveData(data);
    populateJobdeskSelect(data.jobdeskBoard);
    hydrateJobdeskForm(data);
    renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);
  });
}

function bindAddStaffForm(data) {
  const form = document.getElementById("add-staff-form");

  if (!form) {
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const nameInput = document.getElementById("new-staff-name");
    const roleInput = document.getElementById("new-staff-role");
    const shiftInput = document.getElementById("new-staff-shift");
    const startTimeInput = document.getElementById("new-staff-start-time");
    const endTimeInput = document.getElementById("new-staff-end-time");
    const normalizedName = nameInput.value.trim();
    const workHours = formatWorkHours(startTimeInput.value, endTimeInput.value);

    if (!normalizedName || !workHours) {
      return;
    }

    const alreadyExists = data.staff.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase());
    if (alreadyExists) {
      nameInput.focus();
      return;
    }

    data.staff.push({
      id: createStaffId(roleInput.value, normalizedName, data.staff.length + 1),
      name: normalizedName,
      group: getGroupByRole(roleInput.value),
      role: roleInput.value,
      shift: shiftInput.value,
      hours: workHours,
      offdayBaseMonth: getMonthKey(),
      offdayBaseCount: 0,
      offdayDates: [],
      offdayUsed: 0
    });

    const newStaff = data.staff[data.staff.length - 1];
    currentScheduleGroup = getGroupByRole(roleInput.value);

    saveData(data);
    refreshStaffSelectors(data, {
      scheduleStaffId: newStaff.id,
      jobdeskAssigned: roleInput.value === "Kasir" ? newStaff.name : undefined
    });
    populateOffdayStaffSelect(data.staff, newStaff.id);
    hydrateScheduleForm(data);
    setActiveScheduleGroupButton();
    renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
    closeAddStaffModal();

    form.reset();
    document.getElementById("new-staff-role").value = "Kasir";
    document.getElementById("new-staff-shift").value = "Pagi";
    syncCustomSelect(document.getElementById("new-staff-role"));
    syncCustomSelect(document.getElementById("new-staff-shift"));
  });
}

function bindScheduleGroupSwitch(data) {
  const buttons = document.querySelectorAll("[data-schedule-group]");

  if (!buttons.length) {
    return;
  }

  buttons.forEach((button) => {
    if (button.dataset.bound === "true") {
      return;
    }

    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      currentScheduleGroup = button.dataset.scheduleGroup;
      setActiveScheduleGroupButton();
      refreshStaffSelectors(data);
      hydrateScheduleForm(data);
      renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
    });
  });
}

function bindJobdeskShiftSwitch(data) {
  const buttons = document.querySelectorAll("[data-shift-filter]");

  if (!buttons.length) {
    return;
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      currentJobdeskShift = button.dataset.shiftFilter;

      buttons.forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);
    });
  });
}

async function resetScheduleGroupToDefault(data, targetGroup) {
  const response = await fetch(DATA_URL);

  if (!response.ok) {
    throw new Error("Gagal membaca data awal schedule.");
  }

  const initialData = prepareInitialTemplate(await response.json());
  const initialGroupStaff = (initialData.staff || []).filter((item) => item.group === targetGroup);
  if (initialGroupStaff.length === 0) {
    data.staff = (data.staff || []).map((item) =>
      item.group === targetGroup
        ? {
            ...item,
            shift: "Libur",
            hours: ""
          }
        : item
    );
    saveData(data);
    return;
  }

  const currentStaffMap = new Map((data.staff || []).map((item) => [item.id, item]));
  const preservedOtherGroups = (data.staff || []).filter((item) => item.group !== targetGroup);

  const resetGroupStaff = initialGroupStaff.map((initialStaff) => {
    const currentStaff = currentStaffMap.get(initialStaff.id);

    if (!currentStaff) {
      return initialStaff;
    }

    return {
      ...initialStaff,
      offdayBaseMonth: currentStaff.offdayBaseMonth,
      offdayBaseCount: currentStaff.offdayBaseCount,
      offdayDates: currentStaff.offdayDates,
      offdayUsed: currentStaff.offdayUsed,
      offdayHistory: currentStaff.offdayHistory,
      offdayLegacyHistory: currentStaff.offdayLegacyHistory
    };
  });

  data.staff = [...preservedOtherGroups, ...resetGroupStaff];
  saveData(data);
}

function bindResetButton(data) {
  const resetButton = document.getElementById("reset-storage");

  if (!resetButton) {
    return;
  }

  if (resetButton.dataset.bound === "true") {
    return;
  }

  resetButton.dataset.bound = "true";

  resetButton.addEventListener("click", async () => {
    const targetGroupLabel = currentScheduleGroup === "SHIFT CS" ? "SHIFT CS" : "SHIFT KAPTEN-KASIR";
    const shouldReset = window.confirm(`Reset schedule ${targetGroupLabel} ke data awal?`);

    if (!shouldReset) {
      return;
    }

    try {
      await resetScheduleGroupToDefault(data, currentScheduleGroup);
      refreshStaffSelectors(data);
      populateOffdayStaffSelect(data.staff);
      hydrateScheduleForm(data);
      renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
    } catch (error) {
      window.alert(error.message);
    }
  });
}

async function resetJobdeskBoardToDefault(data) {
  const response = await fetch(DATA_URL);

  if (!response.ok) {
    throw new Error("Gagal membaca data awal jobdesk.");
  }

  const initialData = await response.json();
  data.jobdeskBoard = normalizeJobdeskBoard(initialData.jobdeskBoard, initialData.jobdeskOptions);
  saveData(data);
}

function resetJobdeskBoardByTarget(data, resetTarget) {
  const targetShifts =
    resetTarget === "Keduanya"
      ? new Set(["Pagi", "Malam"])
      : new Set([resetTarget]);

  data.jobdeskBoard = (data.jobdeskBoard || []).map((item) => {
    if (!targetShifts.has(item.shift)) {
      return item;
    }

    return {
      ...item,
      assignedTo: ""
    };
  });

  saveData(data);
}

function bindResetJobdeskBoard(data) {
  const resetButton = document.getElementById("reset-jobdesk-board");
  const jobdeskSelect = document.getElementById("jobdesk-id");
  const resetModal = document.getElementById("jobdesk-reset-modal");
  const closeButton = document.getElementById("close-jobdesk-reset");
  const optionButtons = document.querySelectorAll("[data-jobdesk-reset-target]");

  if (!resetButton || !jobdeskSelect || !resetModal || !closeButton || !optionButtons.length) {
    return;
  }

  if (resetButton.dataset.bound === "true") {
    return;
  }

  resetButton.dataset.bound = "true";

  resetButton.addEventListener("click", () => {
    setJobdeskResetFeedback("");
    openJobdeskResetModal();
  });

  closeButton.addEventListener("click", () => {
    closeJobdeskResetModal();
  });

  resetModal.addEventListener("click", (event) => {
    if (event.target === resetModal) {
      closeJobdeskResetModal();
    }
  });

  optionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const resetTarget = button.dataset.jobdeskResetTarget;
      const resetLabel =
        resetTarget === "Keduanya"
          ? "Shift Pagi dan Shift Malam"
          : `Shift ${resetTarget}`;
      const shouldReset = window.confirm(`Reset Jobdesk Kasir untuk ${resetLabel}?`);

      if (!shouldReset) {
        return;
      }

      resetJobdeskBoardByTarget(data, resetTarget);
      const previousSelectedJobdesk = jobdeskSelect.value;
      populateJobdeskSelect(data.jobdeskBoard);

      if (previousSelectedJobdesk && data.jobdeskBoard.some((item) => item.jobdesk === previousSelectedJobdesk)) {
        jobdeskSelect.value = previousSelectedJobdesk;
      }

      hydrateJobdeskForm(data);
      renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);
      setJobdeskResetFeedback(`Jobdesk Kasir untuk ${resetLabel} berhasil dikosongkan.`);

      window.setTimeout(() => {
        closeJobdeskResetModal();
        setJobdeskResetFeedback("");
      }, 250);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && resetModal.classList.contains("is-open")) {
      closeJobdeskResetModal();
    }
  });
}

function bindFocusAddStaffButton() {
  const button = document.getElementById("focus-add-staff");
  const nameInput = document.getElementById("new-staff-name");

  if (!button || !nameInput) {
    return;
  }

  button.addEventListener("click", () => {
    openAddStaffModal();
    nameInput.focus();
  });
}

function bindFocusStaffSettingButton(data) {
  const button = document.getElementById("focus-staff-setting");

  if (!button) {
    return;
  }

  if (button.dataset.bound === "true") {
    return;
  }

  button.dataset.bound = "true";

  button.addEventListener("click", () => {
    staffSettingDraft = cloneStaffSettingDraft(data.staff);
    renderStaffSettingList();
    setStaffSettingFeedback("");
    openStaffSettingModal();
  });
}

function bindFocusOffdayButton(data) {
  const button = document.getElementById("focus-offday");
  const staffSelect = document.getElementById("offday-staff");
  const scheduleSelect = document.getElementById("schedule-staff");

  if (!button || !staffSelect) {
    return;
  }

  button.addEventListener("click", () => {
    populateOffdayStaffSelect(data.staff, scheduleSelect?.value || staffSelect.value);

    if (scheduleSelect?.value) {
      staffSelect.value = scheduleSelect.value;
    }

    openOffdayModal();
    syncCustomSelect(staffSelect);
  });
}

function bindAddStaffModal() {
  const modal = document.getElementById("add-staff-modal");
  const closeButton = document.getElementById("close-add-staff");

  if (!modal || !closeButton) {
    return;
  }

  closeButton.addEventListener("click", () => {
    closeAddStaffModal();
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeAddStaffModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeAddStaffModal();
    }
  });
}

function bindStaffSettingModal(data) {
  const modal = document.getElementById("staff-setting-modal");
  const closeButton = document.getElementById("close-staff-setting");
  const form = document.getElementById("staff-setting-form");
  const list = document.getElementById("staff-setting-list");

  if (!modal || !closeButton || !form || !list) {
    return;
  }

  if (modal.dataset.bound === "true") {
    return;
  }

  modal.dataset.bound = "true";

  closeButton.addEventListener("click", () => {
    closeStaffSettingModal();
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeStaffSettingModal();
    }
  });

  list.addEventListener("input", (event) => {
    const target = event.target;

    if (!target.matches(".staff-setting-name")) {
      return;
    }

    const staff = staffSettingDraft.find((item) => item.id === target.dataset.staffId);

    if (!staff) {
      return;
    }

    staff.name = target.value;
    setStaffSettingFeedback("");
  });

  list.addEventListener("change", (event) => {
    const target = event.target;

    if (!target.matches(".staff-setting-role")) {
      return;
    }

    const staff = staffSettingDraft.find((item) => item.id === target.dataset.staffId);

    if (!staff) {
      return;
    }

    staff.role = target.value;
    staff.group = getGroupByRole(target.value);
    renderStaffSettingList();
    setStaffSettingFeedback("");
  });

  list.addEventListener("click", (event) => {
    const resetOffdayButton = event.target.closest("[data-reset-offday-id]");

    if (resetOffdayButton) {
      const staffId = resetOffdayButton.dataset.resetOffdayId;
      const currentMonthKey = getMonthKey();
      const staff = data.staff.find((item) => item.id === staffId);
      const draftStaff = staffSettingDraft.find((item) => item.id === staffId);
      const shouldReset = window.confirm(`Reset OFF-DAY bulan ini untuk ${staff?.name || draftStaff?.name || "staff ini"}?`);

      if (!shouldReset) {
        return;
      }

      if (staff) {
        resetStaffCurrentMonthOffday(staff, currentMonthKey);
      }

      if (draftStaff) {
        resetStaffCurrentMonthOffday(draftStaff, currentMonthKey);
      }

      saveData(data);
      populateOffdayStaffSelect(data.staff);
      renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
      renderStaffSettingList();
      setStaffSettingFeedback("OFF-DAY bulan ini berhasil direset.");
      return;
    }

    const deleteButton = event.target.closest("[data-delete-staff-id]");

    if (!deleteButton) {
      return;
    }

    const staff = staffSettingDraft.find((item) => item.id === deleteButton.dataset.deleteStaffId);
    const shouldDelete = window.confirm(`Hapus staff ${staff?.name || ""}?`);

    if (!shouldDelete) {
      return;
    }

    staffSettingDraft = staffSettingDraft.filter((item) => item.id !== deleteButton.dataset.deleteStaffId);
    renderStaffSettingList();
    setStaffSettingFeedback("");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const validationMessage = validateStaffSettingDraft();

    if (validationMessage) {
      setStaffSettingFeedback(validationMessage);
      return;
    }

    const previousStaff = cloneStaffSettingDraft(data.staff);
    const previousScheduleValue = document.getElementById("schedule-staff")?.value;
    const previousAssignedName = document.getElementById("jobdesk-assigned")?.value;
    const previousAssignedStaff = previousStaff.find((item) => item.name === previousAssignedName);
    const previousScheduleStaff = previousStaff.find((item) => item.id === previousScheduleValue);

    data.staff = staffSettingDraft.map((item) => ({
      ...item,
      name: item.name.trim(),
      role: item.role,
      group: getGroupByRole(item.role)
    }));

    syncJobdeskAssignmentsWithStaff(data, previousStaff);
    ensureValidCurrentScheduleGroup(data);
    saveData(data);
    refreshStaffSelectors(data, {
      scheduleStaffId: previousScheduleStaff?.id,
      jobdeskAssigned: previousAssignedStaff
        ? data.staff.find((item) => item.id === previousAssignedStaff.id && item.role === "Kasir")?.name
        : undefined
    });
    populateOffdayStaffSelect(data.staff);
    hydrateScheduleForm(data);
    hydrateJobdeskForm(data);
    renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));
    renderJobdeskTable(data.jobdeskBoard, currentJobdeskShift);
    renderStaffSettingList();
    setStaffSettingFeedback("Perubahan staff berhasil disimpan.");

    window.setTimeout(() => {
      closeStaffSettingModal();
      setStaffSettingFeedback("");
    }, 300);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeStaffSettingModal();
    }
  });
}

function bindOffdayModal() {
  const modal = document.getElementById("offday-modal");
  const closeButton = document.getElementById("close-offday");

  if (!modal || !closeButton) {
    return;
  }

  closeButton.addEventListener("click", () => {
    closeOffdayModal();
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeOffdayModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeOffdayModal();
    }
  });
}

function bindOffdayForm(data) {
  const form = document.getElementById("offday-form");
  const feedback = document.getElementById("offday-feedback");

  if (!form) {
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const staffId = document.getElementById("offday-staff").value;
    const offdayDate = document.getElementById("offday-date").value;
    const staff = data.staff.find((item) => item.id === staffId);

    if (!staff || !offdayDate) {
      return;
    }

    const offdayMonthKey = getMonthKey(offdayDate);
    const totalForMonth = getMonthlyOffdayTotal(staff, offdayMonthKey);
    const alreadyExists = getOffdayDatesForMonth(staff, offdayMonthKey).includes(offdayDate);

    if (alreadyExists) {
      setOffdayFeedback("Tanggal OFF-DAY ini sudah tersimpan.");
      return;
    }

    if (totalForMonth >= data.maxOffdayPerMonth) {
      setOffdayFeedback("Batas OFF-DAY bulan ini sudah habis.");
      return;
    }

    staff.offdayHistory = normalizeOffdayHistoryMap(staff.offdayHistory, staff.offdayDates || []);
    staff.offdayHistory[offdayMonthKey] = [...new Set([...(staff.offdayHistory[offdayMonthKey] || []), offdayDate])].sort();
    staff.offdayDates = staff.offdayHistory[getMonthKey()] || [];
    saveData(data);
    setOffdayFeedback("OFF-DAY berhasil disimpan.");

    renderScheduleTable(data, getScheduleStaffByGroup(data, currentScheduleGroup));

    setTimeout(() => {
      closeOffdayModal();
      if (feedback) {
        feedback.textContent = "";
      }
    }, 500);
  });
}

function hydrateScheduleForm(data) {
  const staffId = document.getElementById("schedule-staff").value;
  const staff = data.staff.find((item) => item.id === staffId) || getScheduleStaffByGroup(data, currentScheduleGroup)[0];
  const scheduleStartTime = document.getElementById("schedule-start-time");
  const scheduleEndTime = document.getElementById("schedule-end-time");

  if (!staff || !scheduleStartTime || !scheduleEndTime) {
    return;
  }

  const { startTime, endTime } = parseWorkHours(staff.hours);

  document.getElementById("schedule-staff").value = staff.id;
  document.getElementById("schedule-shift").value = staff.shift;
  scheduleStartTime.value = startTime;
  scheduleEndTime.value = endTime;
  syncCustomSelect(document.getElementById("schedule-staff"));
  syncCustomSelect(document.getElementById("schedule-shift"));
}

function hydrateJobdeskForm(data) {
  const jobdeskIdSelect = document.getElementById("jobdesk-id");
  const assignedSelect = document.getElementById("jobdesk-assigned");
  const shiftSelect = document.getElementById("jobdesk-shift");
  const selectedJobdeskName = jobdeskIdSelect?.value;
  const selectedShift = normalizeJobdeskShift(shiftSelect?.value);
  const jobdesk =
    getJobdeskAssignment(data.jobdeskBoard, selectedJobdeskName, selectedShift) ||
    getJobdeskAssignment(data.jobdeskBoard, data.jobdeskOptions?.[0], selectedShift) ||
    data.jobdeskBoard[0];
  const cashierOperators = getCashierOperators(data);

  if (!jobdesk || !assignedSelect || !shiftSelect || !jobdeskIdSelect) {
    return;
  }

  jobdeskIdSelect.value = jobdesk.jobdesk;
  shiftSelect.value = normalizeJobdeskShift(jobdesk.shift);

  if (cashierOperators.length === 0) {
    assignedSelect.value = "";
    syncCustomSelect(jobdeskIdSelect);
    syncCustomSelect(assignedSelect);
    syncCustomSelect(shiftSelect);
    return;
  }

  const assignedExists = cashierOperators.some((item) => item.name === jobdesk.assignedTo);
  const assignedValue = assignedExists ? jobdesk.assignedTo : cashierOperators[0].name;

  assignedSelect.value = assignedValue;
  syncCustomSelect(jobdeskIdSelect);
  syncCustomSelect(assignedSelect);
  syncCustomSelect(shiftSelect);
}

function populateStaffSelect(targetId, rows, onlyCashier) {
  const select = document.getElementById(targetId);
  if (!select) {
    return;
  }

  const source = onlyCashier ? rows.filter((item) => item.role === "Kasir" || item.role === "Kapten") : rows;

  if (source.length === 0) {
    const placeholder = targetId === "jobdesk-assigned" ? "Belum ada staff kasir" : "Belum ada staff pada grup ini";
    select.innerHTML = `<option value="">${placeholder}</option>`;
    select.value = "";
    select.disabled = true;
    syncCustomSelect(select);
    return;
  }

  select.disabled = false;
  select.innerHTML = source
    .map((item) => `<option value="${targetId === "schedule-staff" ? item.id : item.name}">${item.name} - ${item.role}</option>`)
    .join("");
}

function refreshStaffSelectors(data, preferredValues = {}) {
  const scheduleStaff = getScheduleStaffByGroup(data, currentScheduleGroup);
  const cashierOperators = getCashierOperators(data);
  const scheduleSelect = document.getElementById("schedule-staff");
  const assignedSelect = document.getElementById("jobdesk-assigned");
  const previousScheduleValue = preferredValues.scheduleStaffId || scheduleSelect?.value;
  const previousAssignedValue = preferredValues.jobdeskAssigned || assignedSelect?.value;

  populateStaffSelect("schedule-staff", scheduleStaff);
  populateStaffSelect("jobdesk-assigned", cashierOperators, true);

  if (scheduleSelect && previousScheduleValue) {
    const scheduleExists = Array.from(scheduleSelect.options).some((option) => option.value === previousScheduleValue);
    if (scheduleExists) {
      scheduleSelect.value = previousScheduleValue;
    }
  }

  if (assignedSelect && previousAssignedValue) {
    const assignedExists = Array.from(assignedSelect.options).some((option) => option.value === previousAssignedValue);
    if (assignedExists) {
      assignedSelect.value = previousAssignedValue;
    }
  }

  syncCustomSelect(scheduleSelect);
  syncCustomSelect(assignedSelect);
}

function populateJobdeskSelect(jobdeskBoard) {
  const select = document.getElementById("jobdesk-id");
  if (!select) {
    return;
  }

  const previousValue = select.value;
  const jobdeskNames = normalizeJobdeskOptions([], jobdeskBoard);

  select.innerHTML = jobdeskNames
    .map((jobdeskName) => `<option value="${jobdeskName}">${jobdeskName}</option>`)
    .join("");

  if (previousValue && Array.from(select.options).some((option) => option.value === previousValue)) {
    select.value = previousValue;
  }

  syncCustomSelect(select);
}

function populateOffdayStaffSelect(rows, preferredId) {
  const select = document.getElementById("offday-staff");
  if (!select) {
    return;
  }

  const previousValue = preferredId || select.value;
  if (!rows.length) {
    select.innerHTML = `<option value="">Belum ada staff</option>`;
    select.value = "";
    select.disabled = true;
    syncCustomSelect(select);
    return;
  }

  select.disabled = false;
  select.innerHTML = [...rows]
    .sort((left, right) => left.name.localeCompare(right.name, "id"))
    .map((item) => `<option value="${item.id}">${item.name} - ${item.role}</option>`)
    .join("");

  if (previousValue && Array.from(select.options).some((option) => option.value === previousValue)) {
    select.value = previousValue;
  }

  syncCustomSelect(select);
}

function getScheduleStaffByGroup(data, group) {
  return data.staff.filter((item) => item.group === group);
}

function getCashierStaff(data) {
  return data.staff.filter((item) => item.group === "SHIFT KAPTEN-KASIR");
}

function getCashierOperators(data) {
  return data.staff.filter((item) => item.role === "Kasir");
}

function sortStaffByShift(rows) {
  const shiftOrder = {
    Pagi: 1,
    Siang: 2,
    Malam: 3,
    Libur: 4
  };

  return [...rows].sort((left, right) => {
    const leftOrder = shiftOrder[left.shift] || 99;
    const rightOrder = shiftOrder[right.shift] || 99;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.name.localeCompare(right.name, "id");
  });
}

function createStaffId(role, name, index) {
  const prefix = role === "CS" ? "cs" : "kk";
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${index}`;
}

function getGroupByRole(role) {
  return role === "CS" ? "SHIFT CS" : "SHIFT KAPTEN-KASIR";
}

function swapJobdeskAssignmentNames(data, fromJobdesk, toJobdesk, shift) {
  const sourceAssignment = getJobdeskAssignment(data.jobdeskBoard, fromJobdesk, shift);
  const targetAssignment = getJobdeskAssignment(data.jobdeskBoard, toJobdesk, shift);

  if (!sourceAssignment || !targetAssignment) {
    return;
  }

  sourceAssignment.jobdesk = toJobdesk;
  sourceAssignment.id = createJobdeskEntryId(toJobdesk, shift);
  targetAssignment.jobdesk = fromJobdesk;
  targetAssignment.id = createJobdeskEntryId(fromJobdesk, shift);

  data.jobdeskBoard = normalizeJobdeskBoard(data.jobdeskBoard, data.jobdeskOptions);
}

function normalizeJobdeskOptions(jobdeskOptions = [], jobdeskBoard = []) {
  return [...new Set([...(jobdeskOptions || []), ...(jobdeskBoard || []).map((item) => item.jobdesk).filter(Boolean)])];
}

function normalizeJobdeskBoard(jobdeskBoard = [], jobdeskOptions = []) {
  const normalizedOptions = normalizeJobdeskOptions(jobdeskOptions, jobdeskBoard);
  const normalizedMap = new Map();

  (jobdeskBoard || []).forEach((item) => {
    const normalizedShift = normalizeJobdeskShift(item.shift);
    const key = `${item.jobdesk}::${normalizedShift}`;

    normalizedMap.set(key, {
      ...item,
      id: item.id || createJobdeskEntryId(item.jobdesk, normalizedShift),
      jobdesk: item.jobdesk,
      shift: normalizedShift,
      assignedTo: String(item.assignedTo || "").trim()
    });
  });

  return normalizedOptions.flatMap((jobdeskName) =>
    JOBDESK_ACTIVE_SHIFTS.map((shift) => {
      const key = `${jobdeskName}::${shift}`;

      return (
        normalizedMap.get(key) || {
          id: createJobdeskEntryId(jobdeskName, shift),
          jobdesk: jobdeskName,
          assignedTo: "",
          backup: "",
          shift,
          notes: ""
        }
      );
    })
  );
}

function normalizeJobdeskShift(shift = "") {
  return String(shift).trim() === "Malam" ? "Malam" : "Pagi";
}

function createJobdeskEntryId(jobdeskName = "", shift = "Pagi") {
  return `job-${jobdeskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${normalizeJobdeskShift(shift).toLowerCase()}`;
}

function getJobdeskAssignment(jobdeskBoard, jobdeskName, shift) {
  return (jobdeskBoard || []).find(
    (item) => item.jobdesk === jobdeskName && normalizeJobdeskShift(item.shift) === normalizeJobdeskShift(shift)
  );
}

function ensureValidCurrentScheduleGroup(data) {
  if (getScheduleStaffByGroup(data, currentScheduleGroup).length > 0) {
    setActiveScheduleGroupButton();
    return;
  }

  currentScheduleGroup = data.staff.some((item) => item.group === "SHIFT CS") ? "SHIFT CS" : "SHIFT KAPTEN-KASIR";
  setActiveScheduleGroupButton();
}

function getJobdeskToneClass(jobdeskName = "", uniqueJobdeskNames = []) {
  if (jobdeskName === "Jobdesk TEMBAK CHIP") {
    return "jobdesk-tone-mahjong";
  }

  if (jobdeskName === "Jobdesk WITHDRAW ( BCA, BNI, E-wallet )") {
    return "jobdesk-tone-withdraw-red";
  }

  const toneClasses = [
    "jobdesk-tone-blue",
    "jobdesk-tone-cyan",
    "jobdesk-tone-green",
    "jobdesk-tone-amber",
    "jobdesk-tone-purple",
    "jobdesk-tone-pink",
    "jobdesk-tone-red",
    "jobdesk-tone-orange",
    "jobdesk-tone-lime",
    "jobdesk-tone-teal",
    "jobdesk-tone-indigo",
    "jobdesk-tone-rose"
  ];
  const sourceNames = uniqueJobdeskNames.length ? uniqueJobdeskNames : [jobdeskName];
  const reorderedNames = [...sourceNames];
  const mandiriIndex = reorderedNames.indexOf("Jobdesk DEPO MANDIRI");
  const manualIndex = reorderedNames.indexOf("Jobdesk DEPO MANUAL / VALIDASI");
  const bniIndex = reorderedNames.indexOf("Jobdesk DEPO BNI");
  const briIndex = reorderedNames.indexOf("Jobdesk DEPO BRI");
  const ewalletIndex = reorderedNames.indexOf("Jobdesk DEPO E-WALLET & HUB ( DANA - GOPAY - OVO - LINKAJA )");

  if (mandiriIndex >= 0 && manualIndex >= 0) {
    [reorderedNames[mandiriIndex], reorderedNames[manualIndex]] = [reorderedNames[manualIndex], reorderedNames[mandiriIndex]];
  }

  if (bniIndex >= 0 && briIndex >= 0) {
    [reorderedNames[bniIndex], reorderedNames[briIndex]] = [reorderedNames[briIndex], reorderedNames[bniIndex]];
  }

  if (manualIndex >= 0 && ewalletIndex >= 0) {
    [reorderedNames[manualIndex], reorderedNames[ewalletIndex]] = [reorderedNames[ewalletIndex], reorderedNames[manualIndex]];
  }

  const toneIndex = reorderedNames.indexOf(jobdeskName);

  return toneClasses[toneIndex >= 0 ? toneIndex % toneClasses.length : 0];
}

function setActiveScheduleGroupButton() {
  document.querySelectorAll("[data-schedule-group]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scheduleGroup === currentScheduleGroup);
  });
}

function formatWorkHours(startTime, endTime) {
  if (!startTime || !endTime) {
    return "";
  }

  return `${startTime} - ${endTime}`;
}

function formatHoursDisplay(hours = "") {
  return String(hours || "").trim() || "-";
}

function parseWorkHours(hours = "") {
  const [startTime = "", endTime = ""] = String(hours)
    .split("-")
    .map((item) => item.trim());

  return {
    startTime,
    endTime
  };
}

function cloneStaffSettingDraft(staff) {
  return (staff || []).map((item) => ({
    ...item
  }));
}

function validateStaffSettingDraft() {
  const normalizedNames = staffSettingDraft.map((item) => item.name.trim()).filter(Boolean);

  if (normalizedNames.length !== staffSettingDraft.length) {
    return "Nama staff tidak boleh kosong.";
  }

  const uniqueNames = new Set(normalizedNames.map((item) => item.toLowerCase()));

  if (uniqueNames.size !== normalizedNames.length) {
    return "Nama staff tidak boleh sama.";
  }

  return "";
}

function renderStaffSettingList() {
  const container = document.getElementById("staff-setting-list");

  if (!container) {
    return;
  }

  if (staffSettingDraft.length === 0) {
    container.innerHTML = `<div class="staff-setting-empty">Belum ada staff untuk diatur.</div>`;
    return;
  }

  container.innerHTML = [...staffSettingDraft]
    .sort((left, right) => {
      if (left.group !== right.group) {
        return left.group.localeCompare(right.group, "id");
      }

      return left.name.localeCompare(right.name, "id");
    })
    .map(
      (item) => `
        <article class="staff-setting-item" data-staff-id="${item.id}">
          <div class="staff-setting-item-head">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.group)} • Shift ${escapeHtml(item.shift)}</span>
            </div>
            <button type="button" class="btn-danger" data-delete-staff-id="${item.id}">Hapus Staff</button>
          </div>
          <div class="staff-setting-grid">
            <label>
              Nama Staff
              <input
                type="text"
                class="staff-setting-name"
                data-staff-id="${item.id}"
                value="${escapeHtml(item.name)}"
                required
              >
            </label>
            <label>
              Role
              <select class="js-custom-select staff-setting-role" data-staff-id="${item.id}">
                <option value="Kasir" ${item.role === "Kasir" ? "selected" : ""}>Kasir</option>
                <option value="Kapten" ${item.role === "Kapten" ? "selected" : ""}>Kapten</option>
                <option value="CS" ${item.role === "CS" ? "selected" : ""}>CS</option>
              </select>
            </label>
          </div>
          <div class="staff-setting-item-meta">
            <span>Jam kerja: ${escapeHtml(item.hours || "-")}</span>
            <div class="staff-setting-offday-actions">
              <span>OFF-DAY bulan ini: ${getMonthlyOffdayTotal(item)}</span>
              <button type="button" class="btn-secondary btn-reset-offday" data-reset-offday-id="${item.id}">Reset OFF-DAY</button>
            </div>
          </div>
        </article>
      `
    )
    .join("");

  initCustomSelects();
}

function syncJobdeskAssignmentsWithStaff(data, previousStaff) {
  const previousStaffByName = new Map((previousStaff || []).map((item) => [item.name, item]));
  const nextStaffById = new Map((data.staff || []).map((item) => [item.id, item]));
  const fallbackCashierName = getCashierOperators(data)[0]?.name || "";

  data.jobdeskBoard = (data.jobdeskBoard || []).map((item) => {
    const previousAssignedStaff = previousStaffByName.get(item.assignedTo);

    if (!previousAssignedStaff) {
      return {
        ...item,
        assignedTo: getCashierOperators(data).some((staff) => staff.name === item.assignedTo) ? item.assignedTo : fallbackCashierName
      };
    }

    const nextAssignedStaff = nextStaffById.get(previousAssignedStaff.id);

    return {
      ...item,
      assignedTo: nextAssignedStaff?.role === "Kasir" ? nextAssignedStaff.name : fallbackCashierName
    };
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getTodayKey() {
  return formatDateKey(new Date());
}

function getMonthKey(dateValue = new Date()) {
  if (typeof dateValue === "string") {
    return dateValue.slice(0, 7);
  }

  return formatDateKey(dateValue).slice(0, 7);
}

function getOffdayDatesForMonth(staff, monthKey = getMonthKey()) {
  return [...new Set((staff.offdayHistory?.[monthKey] || []).filter(Boolean))].sort();
}

function getMonthlyOffdayTotal(staff, monthKey = getMonthKey()) {
  const legacyCount = Number(staff.offdayLegacyHistory?.[monthKey] || 0);
  return legacyCount + getOffdayDatesForMonth(staff, monthKey).length;
}

function resetStaffCurrentMonthOffday(staff, monthKey = getMonthKey()) {
  if (!staff) {
    return;
  }

  const nextOffdayHistory = normalizeOffdayHistoryMap(staff.offdayHistory, staff.offdayDates || []);
  const nextLegacyHistory = { ...(staff.offdayLegacyHistory || {}) };

  delete nextOffdayHistory[monthKey];
  delete nextLegacyHistory[monthKey];

  staff.offdayHistory = nextOffdayHistory;
  staff.offdayLegacyHistory = nextLegacyHistory;
  staff.offdayDates = [];
  staff.offdayBaseMonth = monthKey;
  staff.offdayBaseCount = 0;
  staff.offdayUsed = 0;
}

function normalizeStaffOffdayState(staff, currentMonthKey = getMonthKey()) {
  const offdayDates = Array.isArray(staff.offdayDates) ? [...new Set(staff.offdayDates.filter(Boolean))] : [];
  const baseMonth = staff.offdayBaseMonth || currentMonthKey;
  const retainedMonths = new Set(getRetainedOffdayMonthKeys(currentMonthKey));
  const fallbackBaseCount = Number.isFinite(Number(staff.offdayBaseCount))
    ? Number(staff.offdayBaseCount)
    : Number(staff.offdayUsed || 0);
  const offdayHistory = pruneHistoryMap(normalizeOffdayHistoryMap(staff.offdayHistory, offdayDates), currentMonthKey);
  const offdayLegacyHistory = pruneLegacyHistoryMap({ ...(staff.offdayLegacyHistory || {}) }, currentMonthKey);
  const knownDatesCount = (offdayHistory[baseMonth] || []).length;
  const legacyDifference = Math.max(fallbackBaseCount - knownDatesCount, 0);

  if (retainedMonths.has(baseMonth) && legacyDifference > 0 && !Number(offdayLegacyHistory[baseMonth])) {
    offdayLegacyHistory[baseMonth] = legacyDifference;
  }

  return {
    ...staff,
    offdayHistory,
    offdayLegacyHistory,
    offdayDates: offdayHistory[currentMonthKey] || [],
    offdayBaseMonth: currentMonthKey,
    offdayBaseCount: 0
  };
}

function getDutyStatus(staff, dateKey = getTodayKey()) {
  if (getOffdayDatesForMonth(staff, getMonthKey(dateKey)).includes(dateKey)) {
    return {
      label: "OFF DAY",
      className: "status-offday"
    };
  }

  return {
    label: "ON DUTY",
    className: "status-duty"
  };
}

function formatDateKey(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const date = String(dateValue.getDate()).padStart(2, "0");

  return `${year}-${month}-${date}`;
}

function normalizeOffdayHistoryMap(historyMap, fallbackDates = []) {
  const normalizedMap = {};

  Object.entries(historyMap || {}).forEach(([monthKey, dates]) => {
    normalizedMap[monthKey] = [...new Set((Array.isArray(dates) ? dates : []).filter(Boolean))].sort();
  });

  fallbackDates.forEach((date) => {
    const monthKey = getMonthKey(date);
    normalizedMap[monthKey] = normalizedMap[monthKey] || [];

    if (!normalizedMap[monthKey].includes(date)) {
      normalizedMap[monthKey].push(date);
      normalizedMap[monthKey].sort();
    }
  });

  return normalizedMap;
}

function pruneHistoryMap(historyMap, currentMonthKey = getMonthKey()) {
  const allowedMonths = new Set(getRetainedOffdayMonthKeys(currentMonthKey));

  return Object.fromEntries(
    Object.entries(historyMap || {}).filter(([monthKey]) => allowedMonths.has(monthKey))
  );
}

function pruneLegacyHistoryMap(historyMap, currentMonthKey = getMonthKey()) {
  const allowedMonths = new Set(getRetainedOffdayMonthKeys(currentMonthKey));

  return Object.fromEntries(
    Object.entries(historyMap || {}).filter(([monthKey]) => allowedMonths.has(monthKey))
  );
}

function getRetainedOffdayMonthKeys(currentMonthKey = getMonthKey()) {
  const [year, month] = currentMonthKey.split("-");
  const baseDate = new Date(Number(year), Number(month) - 1, 1);

  return getRecentMonthKeys(7, baseDate);
}

function getRecentMonthKeys(monthCount = 6, fromDate = new Date()) {
  return Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(fromDate.getFullYear(), fromDate.getMonth() - index, 1);
    return getMonthKey(date);
  });
}

function getOffdaySlotsForMonth(staff, monthKey) {
  const datedEntries = getOffdayDatesForMonth(staff, monthKey).map((date) => ({
    type: "date",
    value: date
  }));
  const legacyCount = Number(staff.offdayLegacyHistory?.[monthKey] || 0);
  const legacyEntries = Array.from({ length: legacyCount }, () => ({
    type: "legacy",
    value: null
  }));

  return [...datedEntries, ...legacyEntries].slice(0, 2);
}

function formatHistoryMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);

  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric"
  }).format(date);
}

function formatOffdaySlotLabel(slot, order) {
  if (!slot) {
    return `OFF DAY ke-${order}: -`;
  }

  if (slot.type === "legacy") {
    return `OFF DAY ke-${order}: Data awal`;
  }

  return `OFF DAY ke-${order}: ${formatOffdayDateLabel(slot.value)}`;
}

function getSlotValueLabel(slot) {
  if (!slot) {
    return "-";
  }

  if (slot.type === "legacy") {
    return "Data awal";
  }

  return formatOffdayDateLabel(slot.value);
}

function getSlotDetailLabel(slot, order) {
  if (!slot) {
    return `Belum ada OFF DAY ke-${order} di bulan ini.`;
  }

  if (slot.type === "legacy") {
    return `Tercatat sebagai data awal OFF DAY ke-${order}.`;
  }

  return `Tanggal ${formatOffdayDateLabel(slot.value)}.`;
}

function formatOffdayDateLabel(dateKey) {
  const [year, month, date] = dateKey.split("-");
  const parsedDate = new Date(Number(year), Number(month) - 1, Number(date));

  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(parsedDate);
}

function initCustomSelects() {
  const selects = document.querySelectorAll("select.js-custom-select");

  selects.forEach((select) => {
    if (select.dataset.customInitialized === "true") {
      syncCustomSelect(select);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "custom-select";
    applyCustomSelectDataClasses(select, wrapper);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger";
    trigger.setAttribute("aria-expanded", "false");
    applyCustomSelectDataClasses(select, trigger, "customTriggerClass");

    const value = document.createElement("span");
    value.className = "custom-select-value";

    const menu = document.createElement("div");
    menu.className = "custom-select-menu";
    menu.setAttribute("role", "listbox");

    select.classList.add("native-select-hidden");
    select.after(wrapper);
    wrapper.appendChild(select);
    trigger.appendChild(value);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (select.disabled) {
        return;
      }

      const shouldOpen = !wrapper.classList.contains("is-open");

      closeAllCustomSelects();

      if (shouldOpen) {
        updateCustomSelectPlacement(wrapper);
        wrapper.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
        setDropdownPanelState(wrapper, true);
      }
    });

    menu.addEventListener("click", (event) => {
      const option = event.target.closest("[data-select-value]");

      if (!option) {
        return;
      }

      select.value = option.dataset.selectValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncCustomSelect(select);
      closeAllCustomSelects();
    });

    menu.addEventListener("wheel", (event) => {
      event.stopPropagation();
    });

    menu.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    select.addEventListener("change", () => {
      syncCustomSelect(select);
    });

    select.dataset.customInitialized = "true";
    syncCustomSelect(select);
  });

  if (document.body.dataset.customSelectGlobalBound === "true") {
    return;
  }

  document.body.dataset.customSelectGlobalBound = "true";

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".custom-select")) {
      closeAllCustomSelects();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllCustomSelects();
    }
  });
}

function syncCustomSelect(select) {
  if (!select || select.dataset.customInitialized !== "true") {
    return;
  }

  const wrapper = select.parentElement;
  const value = wrapper.querySelector(".custom-select-value");
  const menu = wrapper.querySelector(".custom-select-menu");
  const trigger = wrapper.querySelector(".custom-select-trigger");
  const selectedOption = select.options[select.selectedIndex];

  applyCustomSelectDataClasses(select, wrapper);
  applyCustomSelectDataClasses(select, trigger, "customTriggerClass");

  if (value) {
    value.textContent = selectedOption ? selectedOption.textContent : "Pilih Opsi";
  }

  if (trigger) {
    trigger.disabled = select.disabled;
    trigger.classList.toggle("is-disabled", select.disabled);
  }

  if (menu) {
    menu.innerHTML = Array.from(select.options)
      .map(
        (option) => `
          <button
            type="button"
            class="custom-select-option ${option.value === select.value ? "is-selected" : ""}"
            data-select-value="${option.value}"
            role="option"
          >
            ${option.textContent}
          </button>
        `
      )
      .join("");

    const selectedMenuOption = menu.querySelector(".custom-select-option.is-selected");
    if (selectedMenuOption) {
      selectedMenuOption.scrollIntoView({
        block: "nearest"
      });
    }
  }
}

function closeAllCustomSelects() {
  document.querySelectorAll(".custom-select.is-open").forEach((wrapper) => {
    wrapper.classList.remove("is-open");
    wrapper.classList.remove("open-up");
    setDropdownPanelState(wrapper, false);

    const trigger = wrapper.querySelector(".custom-select-trigger");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
    }
  });
}

function applyCustomSelectDataClasses(select, element, dataKey = "customWrapperClass") {
  if (!select || !element) {
    return;
  }

  const marker = dataKey === "customWrapperClass" ? "customWrapperClassApplied" : "customTriggerClassApplied";
  const previousClasses = (select.dataset[marker] || "").split(" ").filter(Boolean);

  previousClasses.forEach((className) => {
    element.classList.remove(className);
  });

  const nextClasses = (select.dataset[dataKey] || "").split(" ").filter(Boolean);
  nextClasses.forEach((className) => {
    element.classList.add(className);
  });

  select.dataset[marker] = nextClasses.join(" ");
}

function updateCustomSelectPlacement(wrapper) {
  if (!wrapper) {
    return;
  }

  wrapper.classList.remove("open-up");

  const trigger = wrapper.querySelector(".custom-select-trigger");
  const menu = wrapper.querySelector(".custom-select-menu");

  if (!trigger || !menu) {
    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const desiredHeight = Math.min(menu.scrollHeight || 260, 260);

  if (spaceBelow < desiredHeight && spaceAbove > spaceBelow) {
    wrapper.classList.add("open-up");
  }
}

function setDropdownPanelState(wrapper, isOpen) {
  const panel = wrapper?.closest(".panel");
  if (!panel) {
    return;
  }

  panel.classList.toggle("is-dropdown-open", isOpen);
}

function openAddStaffModal() {
  const modal = document.getElementById("add-staff-modal");

  if (!modal) {
    return;
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeAddStaffModal() {
  const modal = document.getElementById("add-staff-modal");

  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openOffdayModal() {
  const modal = document.getElementById("offday-modal");
  const dateInput = document.getElementById("offday-date");

  if (!modal) {
    return;
  }

  if (dateInput && !dateInput.value) {
    dateInput.value = getTodayKey();
  }

  setOffdayFeedback("");
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeOffdayModal() {
  const modal = document.getElementById("offday-modal");
  const form = document.getElementById("offday-form");

  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  setOffdayFeedback("");

  if (form) {
    form.reset();
  }
}

function openStaffSettingModal() {
  const modal = document.getElementById("staff-setting-modal");

  if (!modal) {
    return;
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeStaffSettingModal() {
  const modal = document.getElementById("staff-setting-modal");

  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openJobdeskResetModal() {
  const modal = document.getElementById("jobdesk-reset-modal");

  if (!modal) {
    return;
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeJobdeskResetModal() {
  const modal = document.getElementById("jobdesk-reset-modal");

  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openHistoryModal() {
  const modal = document.getElementById("history-modal");

  if (!modal) {
    return;
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeHistoryModal() {
  const modal = document.getElementById("history-modal");

  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function setOffdayFeedback(message) {
  const feedback = document.getElementById("offday-feedback");

  if (feedback) {
    feedback.textContent = message;
  }
}

function setStaffSettingFeedback(message) {
  const feedback = document.getElementById("staff-setting-feedback");

  if (feedback) {
    feedback.textContent = message;
  }
}

function setJobdeskResetFeedback(message) {
  const feedback = document.getElementById("jobdesk-reset-feedback");

  if (feedback) {
    feedback.textContent = message;
  }
}

function getOffdayStatus(offdayUsed, maxOffday) {
  const used = Number(offdayUsed || 0);

  if (used >= maxOffday) {
    return {
      label: "Peringatan: batas habis",
      className: "status-danger"
    };
  }

  if (used === maxOffday - 1) {
    return {
      label: "Waspada: sisa 1",
      className: "status-warning"
    };
  }

  return {
    label: "Aman",
    className: "status-safe"
  };
}

function clampNumber(value, min, max) {
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    return min;
  }

  return Math.min(Math.max(parsed, min), max);
}

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function startRealtimeDisplay() {
  updateRealtimeDisplay();

  if (document.body.dataset.realtimeBound === "true") {
    return;
  }

  document.body.dataset.realtimeBound = "true";
  window.setInterval(updateRealtimeDisplay, 1000);
}

function updateRealtimeDisplay() {
  const realtimeText = formatRealtimeDate(new Date());
  setText("cs-realtime", realtimeText);
  setText("kk-realtime", realtimeText);
}

function formatRealtimeDate(dateValue) {
  const dateFormatter = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const timeText = [
    String(dateValue.getHours()).padStart(2, "0"),
    String(dateValue.getMinutes()).padStart(2, "0"),
    String(dateValue.getSeconds()).padStart(2, "0")
  ].join(":");

  return `${dateFormatter.format(dateValue)} | ${timeText}`;
}

function renderLoadError(error) {
  const main = document.querySelector(".content-grid");
  if (!main) {
    return;
  }

  main.innerHTML = `
    <section class="panel">
      <div class="empty-state">
        <h2>Data tidak bisa dimuat</h2>
        <p>Pastikan file dibuka lewat local server agar file JSON bisa terbaca.</p>
        <p>${error.message}</p>
      </div>
    </section>
  `;
}
