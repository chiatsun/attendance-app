// --- State Management ---
let state = {
  isPunchedIn: false,
  punchInTime: null,
  workType: 'normal',     // 'normal' | 'overtime'
  displayMode: 'elapsed', // 'elapsed' | 'countdown'
  leaveSettings: { enabled: false, type: 'flexible', hours: 4 },
  records: []
};

// Notification settings (persisted separately)
let notifySettings = {
  enabled: false,
  minsBefore: 5  // default: 5 minutes before punch-out
};

// Runtime flag — reset each punch-in so we only fire once per session
let _notifyFired = false;

// Break durations and work hours config
const WORK_CONFIG = {
  normal:   { breakMins: 50, label: '上班',   breakLabel: '（中間休息50分鐘）' },
  overtime: { breakMins: 30, label: '加班',   breakLabel: '（中間休息30分鐘）' }
};
const WORK_HOURS = 8; // hours of actual work

// --- Google Sheets 雙向同步設定 ---
const SHEETS_API_URL = 'https://script.google.com/macros/s/AKfycbw5Di1lfWL3_SkCQiMxiVxiAh3JZ2ULgTkTGq656CDGgFqrxZ1MJL5Ca5y34s_U39AhSQ/exec';

// 記住試算表最後一列的列號（用於下班打卡時更新同一列）
let _sheetsLastRow = parseInt(localStorage.getItem('attendance_sheets_last_row') || '0', 10);

// --- Initialize App ---
function init() {
  loadData();
  startClock();
  updateUI();
  updateHistoryUI();
  syncNotifyUI();
  syncLeaveUI();
  setupPickerInterceptor();
  // 從 Google 試算表讀取最後一筆打卡狀態
  syncLoadFromSheets();
}

// --- Data Layer ---
function loadData() {
  const savedState = localStorage.getItem('attendance_state');
  if (savedState) {
    const parsed = JSON.parse(savedState);
    state.isPunchedIn = parsed.isPunchedIn;
    state.punchInTime = parsed.punchInTime ? new Date(parsed.punchInTime) : null;
    state.workType = parsed.workType || 'normal';
    if (parsed.leaveSettings) {
      state.leaveSettings = {
        enabled: parsed.leaveSettings.enabled || false,
        type: parsed.leaveSettings.type || 'flexible',
        hours: parsed.leaveSettings.hours || 4
      };
    }
  }

  const savedRecords = localStorage.getItem('attendance_records');
  if (savedRecords) {
    state.records = JSON.parse(savedRecords).map(r => ({
      ...r,
      in: new Date(r.in),
      out: r.out ? new Date(r.out) : null
    }));
  }

  // Load notification settings
  const savedNotify = localStorage.getItem('attendance_notify');
  if (savedNotify) {
    Object.assign(notifySettings, JSON.parse(savedNotify));
  }
}

function saveData() {
  localStorage.setItem('attendance_state', JSON.stringify({
    isPunchedIn: state.isPunchedIn,
    punchInTime: state.punchInTime,
    workType: state.workType,
    leaveSettings: state.leaveSettings
  }));
  localStorage.setItem('attendance_records', JSON.stringify(state.records));
}

function saveNotifySettings() {
  localStorage.setItem('attendance_notify', JSON.stringify(notifySettings));
}

// --- Clock Logic ---
function startClock() {
  setInterval(updateClock, 1000);
  updateClock();
}

function updateClock() {
  const now = new Date();

  // Format Time: HH:MM:SS
  const timeStr = now.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('current-time').textContent = timeStr;

  // Format Date: YYYY年MM月DD日 星期X
  const dateOptions = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
  document.getElementById('current-date').textContent = now.toLocaleDateString('zh-TW', dateOptions);

  // Update Work Duration / Countdown
  if (state.isPunchedIn && state.punchInTime) {
    const durEl = document.getElementById('work-duration');

    if (state.displayMode === 'countdown') {
      // --- Countdown to estimated punch-out ---
      const currentRecord = state.records[0];
      if (currentRecord && currentRecord.estimatedOut) {
        const estOut = new Date(currentRecord.estimatedOut);
        const remainMs = estOut - now;

        if (remainMs <= 0) {
          // Overtime!
          const overMs  = Math.abs(remainMs);
          const overHrs = Math.floor(overMs / 3600000);
          const overMin = Math.floor((overMs % 3600000) / 60000);
          const overSec = Math.floor((overMs % 60000) / 1000);
          durEl.textContent = `+${pad(overHrs)}:${pad(overMin)}:${pad(overSec)}`;
          durEl.classList.add('overtime');
        } else {
          const rHrs = Math.floor(remainMs / 3600000);
          const rMin = Math.floor((remainMs % 3600000) / 60000);
          const rSec = Math.floor((remainMs % 60000) / 1000);
          durEl.textContent = `${pad(rHrs)}:${pad(rMin)}:${pad(rSec)}`;
          durEl.classList.remove('overtime');
        }
      }
    } else {
      // --- Elapsed time since punch-in ---
      const diffMs = now - state.punchInTime;
      const hrs = Math.floor(diffMs / 3600000);
      const mins = Math.floor((diffMs % 3600000) / 60000);
      const secs = Math.floor((diffMs % 60000) / 1000);
      durEl.textContent = `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
      durEl.classList.remove('overtime');
    }
  }

  // Check reminder notification
  checkReminder();
}

function pad(num) {
  return num.toString().padStart(2, '0');
}

// --- Work Type & Manual Time Logic ---
window.setWorkType = function(type) {
  state.workType = type;
  document.getElementById('type-normal').classList.toggle('active', type === 'normal');
  document.getElementById('type-overtime').classList.toggle('active', type === 'overtime');

  const manualTimeInput = document.getElementById('manual-time');
  const hintEl = document.getElementById('manual-time-hint');

  if (type === 'normal') {
    manualTimeInput.min = "06:10";
    manualTimeInput.max = "10:00";
    manualTimeInput.readOnly = true; // Prevents native picker!
    if (hintEl) {
      hintEl.innerHTML = '點選上方時間開啟選單 <span style="color:#e74c3c; font-weight:600;">(彈性上班時間:06:10~10:00)</span>';
    }
  } else {
    manualTimeInput.removeAttribute('min');
    manualTimeInput.removeAttribute('max');
    manualTimeInput.readOnly = false;
    if (hintEl) {
      hintEl.textContent = '留空則以按下「上班打卡」時的時間為準';
    }
  }
  
  if (type !== 'normal') {
    closeQuickPicker();
  }
};

// --- Display Mode Toggle (elapsed ↔ countdown) ---
window.toggleDisplayMode = function() {
  state.displayMode = (state.displayMode === 'elapsed') ? 'countdown' : 'elapsed';
  syncModeToggleBtn();
  // Remove overtime flash when switching away from countdown
  if (state.displayMode === 'elapsed') {
    document.getElementById('work-duration').classList.remove('overtime');
  }
};

function syncModeToggleBtn() {
  const btn = document.getElementById('mode-toggle-btn');
  if (!btn) return;
  if (state.displayMode === 'countdown') {
    btn.innerHTML = `<span class="material-icons-round">timer</span> 離下班倒數`;
    btn.classList.add('mode-countdown');
  } else {
    btn.innerHTML = `<span class="material-icons-round">schedule</span> 已上班時間`;
    btn.classList.remove('mode-countdown');
  }
}


window.clearManualTime = function() {
  document.getElementById('manual-time').value = '';
};

// --- Notification Logic ---

/**
 * Called when user flips the notification toggle.
 * Requests permission if enabling for the first time.
 */
window.onNotifyToggle = async function(checked) {
  if (checked) {
    const granted = await requestNotifyPermission();
    if (!granted) {
      // Permission denied — revert the toggle
      document.getElementById('notify-toggle').checked = false;
      return;
    }
  }
  notifySettings.enabled = checked;
  _notifyFired = false;
  saveNotifySettings();
  syncNotifyUI();
};

/** Set how many minutes before punch-out to send reminder */
window.setNotifyMins = function(mins) {
  notifySettings.minsBefore = mins;
  saveNotifySettings();
  // Reset fired flag so the new time triggers properly
  _notifyFired = false;
  // Update full UI (including hint text)
  syncNotifyUI();
};

/** Sync notification UI (toggle, preset buttons, hint text) */
function syncNotifyUI() {
  const toggle = document.getElementById('notify-toggle');
  const presetsEl = document.getElementById('notify-presets');
  const hintEl = document.getElementById('notify-hint');
  const iconEl = document.querySelector('.switch-icon');

  if (!toggle) return;

  toggle.checked = notifySettings.enabled;

  if (iconEl) {
    iconEl.textContent = notifySettings.enabled ? 'notifications_active' : 'notifications_off';
  }

  // Preset buttons are always clickable — user can set time before enabling
  // (No opacity/pointer-events restriction)

  if (hintEl) {
    if (notifySettings.enabled) {
      hintEl.textContent = `已開啟：下班前 ${notifySettings.minsBefore} 分鐘發送提醒`;
      hintEl.style.color = 'var(--success-color)';
      hintEl.style.opacity = '1';
    } else {
      hintEl.textContent = `目前設定：提前 ${notifySettings.minsBefore} 分鐘（開啟開關即生效）`;
      hintEl.style.color = '';
      hintEl.style.opacity = '0.8';
    }
  }

  // Sync preset active state
  [5, 10, 15, 30].forEach(m => {
    const btn = document.getElementById(`preset-${m}`);
    if (btn) btn.classList.toggle('active', m === notifySettings.minsBefore);
  });
}

/** Ask for browser notification permission */
async function requestNotifyPermission() {
  if (!('Notification' in window)) {
    alert('您的瀏覽器不支援通知功能');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// --- Leave Logic ---
// --- Leave Logic ---
function syncLeaveUI() {
  const settings = state.leaveSettings;
  const isFlex = settings.enabled && settings.type === 'flexible';
  const isFixed = settings.enabled && settings.type === 'fixed';

  // Toggle Switches & Icons
  const fToggle = document.getElementById('leave-flexible-toggle');
  const fIcon = document.getElementById('leave-flexible-icon');
  if (fToggle) fToggle.checked = isFlex;
  if (fIcon) {
    fIcon.textContent = isFlex ? 'beach_access' : 'event_busy';
    fIcon.style.color = isFlex ? 'var(--success-color)' : '#aaa';
  }

  const xToggle = document.getElementById('leave-fixed-toggle');
  const xIcon = document.getElementById('leave-fixed-icon');
  if (xToggle) xToggle.checked = isFixed;
  if (xIcon) {
    xIcon.textContent = isFixed ? 'notifications_active' : 'event_busy';
    xIcon.style.color = isFixed ? '#3498db' : '#aaa';
  }

  // Groups
  const fGroup = document.getElementById('group-flexible-hours');
  if (fGroup) {
    fGroup.style.opacity = isFlex ? '1' : '0.5';
    fGroup.style.pointerEvents = isFlex ? '' : 'none';
  }
  const xGroup = document.getElementById('group-fixed-hours');
  if (xGroup) {
    xGroup.style.opacity = isFixed ? '1' : '0.5';
    xGroup.style.pointerEvents = isFixed ? '' : 'none';
  }

  // Logic Helpers
  const wt = (state.records[0] && state.records[0].workType) || state.workType;
  const config = WORK_CONFIG[wt];
  const canShowRange = state.isPunchedIn && state.records.length > 0;
  const stdOut = (state.isPunchedIn && state.punchInTime) ? calculatePunchOut(state.punchInTime, wt, 0) : null;
  const fmt = { hour12: false, hour: '2-digit', minute: '2-digit' };

  // 4. Update Buttons for Both Cards
  for (let i = 1; i <= 8; i++) {
    // Flexible
    const fBtn = document.getElementById(`flex-leave-${i}`);
    if (fBtn) fBtn.classList.toggle('active', isFlex && i === settings.hours);
    const fTime = document.getElementById(`flex-time-${i}`);
    if (fTime) {
      if (canShowRange && stdOut) {
        let startMs = stdOut.getTime() - (i * 3600000);
        if (i > 4) startMs -= (config.breakMins * 60 * 1000);
        const start = new Date(startMs);
        fTime.textContent = `(${start.toLocaleTimeString('zh-TW', fmt)} 起)`;
      } else {
        fTime.textContent = '';
      }
    }

    // Fixed
    const xBtn = document.getElementById(`fixed-leave-${i}`);
    if (xBtn) xBtn.classList.toggle('active', isFixed && i === settings.hours);
    const xTime = document.getElementById(`fixed-time-${i}`);
    if (xTime) {
      let endMs = i * 3600000;
      if (i > 4) endMs += 50 * 60000; // Break gap
      const base = new Date(); base.setHours(8, 30, 0, 0);
      const end = new Date(base.getTime() + endMs);
      xTime.textContent = `(~${end.toLocaleTimeString('zh-TW', fmt)})`;
    }
  }

  // 5. Update Summaries
  const fSummary = document.getElementById('leave-flexible-summary');
  if (fSummary) {
    if (isFlex && canShowRange && stdOut) {
      const flexHrs = settings.hours;
      // We will use the calculatePunchOut helper below to get the exact start/end
      
      // Let's use a simpler way: The leave period ends at stdOut.
      // The start is stdOut minus (hours + break if hours spans lunch)
      // Actually, Example (2) says: 09:15 in, Out at 14:05.
      // Leave 4h starts at 14:05 - 4h = 10:05? No, they start leave at 14:05.
      // Wait! The user says: "假單填寫時間為 14:05-18:05" (4 hours).
      // This means the leave is AFTER the 4 hours of work.
      // 09:15 + 4h work + 50m break = 14:05.
      // So Leave starts at 14:05.
      // And Ends at 18:05.
      // My calculatePunchOut(0, 0) gives 18:05.
      // My calculatePunchOut(hours) gives 14:05.
      // So Leave Range = [calculatePunchOut(hours) to calculatePunchOut(0)].
      
      const leaveStart = calculatePunchOut(state.punchInTime, wt, flexHrs);
      const leaveEnd = calculatePunchOut(state.punchInTime, wt, 0);

      const fRange = document.getElementById('leave-flexible-range');
      if (fRange) fRange.textContent = `預計請假時段：${leaveStart.toLocaleTimeString('zh-TW', fmt)} ~ ${leaveEnd.toLocaleTimeString('zh-TW', fmt)}`;
      fSummary.style.display = 'flex';
    } else {
      fSummary.style.display = 'none';
    }
  }

  const xSummary = document.getElementById('leave-fixed-summary');
  if (xSummary) {
    if (isFixed) {
      let endMs = settings.hours * 3600000;
      if (settings.hours > 4) endMs += 50 * 60000;
      const base = new Date(); base.setHours(8, 30, 0, 0);
      const end = new Date(base.getTime() + endMs);
      const xRange = document.getElementById('leave-fixed-range');
      if (xRange) xRange.textContent = `預計請假時段：08:30 ~ ${end.toLocaleTimeString('zh-TW', fmt)}`;
      
      const reminder = document.getElementById('leave-fixed-reminder');
      const reminderTime = document.getElementById('leave-fixed-reminder-time');
      if (reminder && reminderTime) {
        if (settings.hours < 8) {
          let clockInTime = new Date(end);
          if (settings.hours === 4) {
            clockInTime.setHours(13, 20, 0, 0);
          }
          reminderTime.textContent = clockInTime.toLocaleTimeString('zh-TW', fmt);
          reminder.style.display = 'block';
        } else {
          reminder.style.display = 'none';
        }
      }
      
      xSummary.style.display = 'flex';
    } else {
      xSummary.style.display = 'none';
      const reminder = document.getElementById('leave-fixed-reminder');
      if (reminder) reminder.style.display = 'none';
    }
  }
}

window.onLeaveToggle = function(type, checked) {
  if (checked) {
    state.leaveSettings.enabled = true;
    state.leaveSettings.type = type;
  } else {
    state.leaveSettings.enabled = false;
  }
  saveData();
  syncLeaveUI();
  recalcCurrentSession();
};

window.setLeaveHours = function(type, hours) {
  state.leaveSettings.enabled = true;
  state.leaveSettings.type = type;
  state.leaveSettings.hours = hours;
  saveData();
  syncLeaveUI();
  recalcCurrentSession();
};

function recalcCurrentSession() {
  if (state.isPunchedIn && state.records.length > 0) {
    const currentRecord = state.records[0];
    if (!currentRecord.out) {
      currentRecord.estimatedOut = calculatePunchOut(state.punchInTime, currentRecord.workType);
      saveData();
      updateUI();
      updateHistoryUI();
    }
  }
}

/**
 * Called every second by updateClock.
 * Fires a notification when we enter the reminder window.
 */
function checkReminder() {
  if (!notifySettings.enabled) return;
  if (!state.isPunchedIn) return;
  if (_notifyFired) return;

  const currentRecord = state.records[0];
  if (!currentRecord || !currentRecord.estimatedOut) return;

  const now = new Date();
  const estOut = new Date(currentRecord.estimatedOut);
  const remainMs = estOut - now;
  const thresholdMs = notifySettings.minsBefore * 60 * 1000;

  // Fire when remaining time drops into the threshold window
  if (remainMs > 0 && remainMs <= thresholdMs) {
    _notifyFired = true;
    fireNotification(estOut, notifySettings.minsBefore);
  }
}

/** Dispatch the browser notification */
function fireNotification(estOut, minsBefore) {
  if (Notification.permission !== 'granted') return;

  const timeStr = estOut.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
  new Notification('✅ 即將下班啊！', {
    body: `您的下班時間 ${timeStr}，還有 ${minsBefore} 分鐘即可下班坏`,
    icon: '🌙'
  });
}


/**
 * Calculate estimated punch-out time:
 *  Total time to stay = 8 work hours + break duration
 */
function calculatePunchOut(punchInTime, workType, specificLeaveHours = null) {
  const config = WORK_CONFIG[workType];
  
  // --- Scenario B: Fixed Mode (Late Arrival / Morning Leave) ---
  if (state.leaveSettings && state.leaveSettings.enabled && state.leaveSettings.type === 'fixed') {
    const out = new Date(punchInTime);
    out.setHours(17, 20, 0, 0); // Always fixed at 17:20
    return out;
  }

  let actualWorkHours = WORK_HOURS; // default 8
  
  if (specificLeaveHours !== null) {
    actualWorkHours = WORK_HOURS - specificLeaveHours;
  } else if (state.leaveSettings && state.leaveSettings.enabled) {
    actualWorkHours = WORK_HOURS - state.leaveSettings.hours;
  }
  
  if (actualWorkHours < 0) actualWorkHours = 0;
  
  // Base reach time (hours of work)
  let punchOut = new Date(punchInTime.getTime() + actualWorkHours * 3600000);

  // --- 休息時間邏輯 ---
  // 只要實際工作時數大於 4 小時，就必須計入休息時間 (Normal 50分 / Overtime 30分)
  if (actualWorkHours > 4) {
    punchOut = new Date(punchOut.getTime() + config.breakMins * 60000);
  }

  return punchOut;
}

// --- Interaction Logic ---
window.handlePunchIn = function() {
  if (state.isPunchedIn) return;

  // Resolve actual punch-in time: manual input OR now
  let punchInTime = new Date();
  const manualVal = document.getElementById('manual-time').value; // "HH:MM"
  if (manualVal) {
    const [h, m] = manualVal.split(':').map(Number);
    punchInTime = new Date();
    punchInTime.setHours(h, m, 0, 0);
  }

  // --- Validate Work Time for 'normal' shift ---
  if (state.workType === 'normal') {
    const isFixedLeave = state.leaveSettings && state.leaveSettings.enabled && state.leaveSettings.type === 'fixed';
    
    // Skip 10:00 restriction if Late Leave mode is active
    if (!isFixedLeave) {
      const h = punchInTime.getHours();
      const m = punchInTime.getMinutes();
      const timeNum = h * 100 + m; // 06:10 -> 610, 10:00 -> 1000
      if (timeNum < 610 || timeNum > 1000) {
        alert('⚠️ 「上班」性質的時間限制在 06:10 ~ 10:00 之間！');
        return;
      }
    }
  }

  state.isPunchedIn = true;
  state.punchInTime = punchInTime;
  _notifyFired = false; // reset so reminder fires fresh for this session

  const estimatedOut = calculatePunchOut(punchInTime, state.workType);

  // Create an open record
  state.records.unshift({
    id: Date.now().toString(),
    date: punchInTime.toLocaleDateString('zh-TW'),
    workType: state.workType,
    in: punchInTime,
    out: null,
    estimatedOut: estimatedOut,
    durationMs: 0
  });

  saveData();
  updateUI();
  updateHistoryUI();
  // 上傳上班記錄到 Google 試算表
  syncClockIn(state.records[0]);
};

window.handlePunchOut = function() {
  if (!state.isPunchedIn) return;
  
  const now = new Date();
  const currentRecord = state.records[0];
  
  if (currentRecord && !currentRecord.out) {
    currentRecord.out = now;
    currentRecord.durationMs = now - currentRecord.in;
  }
  
  state.isPunchedIn = false;
  state.punchInTime = null;

  saveData();
  updateUI();
  updateHistoryUI();
  // 更新 Google 試算表最後一列的下班時間
  if (currentRecord) syncClockOut(currentRecord);
};

// --- UI Updates ---
function updateUI() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const dur = document.getElementById('work-duration');
  const estimateEl = document.getElementById('punchout-estimate');
  const estimateTime = document.getElementById('punchout-time-display');
  const breakLabel = document.getElementById('break-label');

  const btnIn = document.getElementById('btn-punch-in');
  const btnOut = document.getElementById('btn-punch-out');
  const settingsCard = document.getElementById('settings-card');
  const manualTimeInput = document.getElementById('manual-time');

  if (state.isPunchedIn) {
    // Hide specific settings when punched in, show status
    const workTypeGroup = document.getElementById('group-work-type');
    const manualTimeGroup = document.getElementById('group-manual-time');
    if (workTypeGroup) {
      workTypeGroup.style.opacity = '0.5';
      workTypeGroup.style.pointerEvents = 'none';
    }
    if (manualTimeGroup) {
      manualTimeGroup.style.opacity = '0.5';
      manualTimeGroup.style.pointerEvents = 'none';
    }
    document.getElementById('type-normal').disabled = true;
    document.getElementById('type-overtime').disabled = true;
    manualTimeInput.disabled = true;

    dot.classList.add('active');
    const cfg = WORK_CONFIG[state.workType];
    
    // 安全檢查：防止 punchInTime 為空導致當機
    if (!state.punchInTime) {
      state.isPunchedIn = false;
      saveData();
      updateUI();
      return;
    }

    const timeInStr = state.punchInTime.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    text.textContent = `目前的狀態：${cfg.label}中 (${timeInStr} 打卡)`;
    text.style.color = 'var(--success-color)';
    dur.classList.add('active');

    // Show estimated punch-out time
    const currentRecord = state.records[0];
    if (currentRecord && currentRecord.estimatedOut) {
      const est = new Date(currentRecord.estimatedOut);
      estimateTime.textContent = est.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
      breakLabel.textContent = cfg.breakLabel;
      estimateEl.style.display = 'flex';
      
      const leaveNote = document.getElementById('leave-note');
      const leaveHrs = document.getElementById('leave-hours-display');
      if (state.leaveSettings && state.leaveSettings.enabled) {
        leaveHrs.textContent = state.leaveSettings.hours;
        leaveNote.style.display = 'block';
      } else {
        leaveNote.style.display = 'none';
      }
    }

    btnIn.classList.add('disabled');
    btnIn.disabled = true;
    btnOut.classList.remove('disabled');
    btnOut.disabled = false;
  } else {
    // Restore settings card interaction
    const workTypeGroup = document.getElementById('group-work-type');
    const manualTimeGroup = document.getElementById('group-manual-time');
    if (workTypeGroup) {
      workTypeGroup.style.opacity = '1';
      workTypeGroup.style.pointerEvents = '';
    }
    if (manualTimeGroup) {
      manualTimeGroup.style.opacity = '1';
      manualTimeGroup.style.pointerEvents = '';
    }
    document.getElementById('type-normal').disabled = false;
    document.getElementById('type-overtime').disabled = false;
    manualTimeInput.disabled = false;

    dot.classList.remove('active');
    text.textContent = '目前的狀態：尚未打卡 / 已下班';
    text.style.color = 'var(--text-secondary)';
    dur.classList.remove('active');
    dur.textContent = '00:00:00';
    estimateEl.style.display = 'none';

    btnIn.classList.remove('disabled');
    btnIn.disabled = false;
    btnOut.classList.add('disabled');
    btnOut.disabled = true;
  }

  // Sync toggle button state
  setWorkType(state.workType);
  syncModeToggleBtn();
  syncLeaveUI();

  // Show mode toggle only when punched in
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  if (modeToggleBtn) {
    modeToggleBtn.style.display = state.isPunchedIn ? 'inline-flex' : 'none';
  }
  // Reset displayMode when clocked out
  if (!state.isPunchedIn) {
    state.displayMode = 'elapsed';
    document.getElementById('work-duration').classList.remove('overtime');
  }
}

function updateHistoryUI() {
  const container = document.getElementById('history-container');
  container.innerHTML = '';
  
  if (state.records.length === 0) {
    container.innerHTML = '<div class="history-empty">目前還沒有打卡紀錄喔！</div>';
    return;
  }

  // 僅顯示「已完成下班」的紀錄，避免誤刪正在進行中的狀態
  const completedRecords = state.records.filter(r => r.out !== null);

  completedRecords.forEach(record => {
    const timeInStr = record.in.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    let timeOutStr, estOutStr = '';

    if (record.out) {
      timeOutStr = record.out.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    } else {
      timeOutStr = '進行中...';
      if (record.estimatedOut) {
        const est = new Date(record.estimatedOut);
        estOutStr = `<span class="history-est">預計下班：${est.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>`;
      }
    }

    const wt = record.workType || 'normal';
    const cfg = WORK_CONFIG[wt];
    const typeTag = `<span class="history-type-tag type-${wt}">${cfg.label}</span>`;

    // Determine the raw elapsed milliseconds to display:
    // For completed records use durationMs; for in-progress use elapsed so far.
    const rawMs = record.out
      ? record.durationMs
      : (new Date() - record.in);

    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const breakMins = cfg.breakMins; // 50 or 30
    const breakMs   = breakMins * 60 * 1000;

    let durStr = '--';
    let breakNote = '';

    if (record.out || rawMs > 0) {
      if (rawMs > FOUR_HOURS_MS) {
        // Deduct break time
        const netMs   = Math.max(0, rawMs - breakMs);
        const netHrs  = Math.floor(netMs / 3600000);
        const netMins = Math.floor((netMs % 3600000) / 60000);
        durStr    = `${netHrs}h ${netMins}m`;
        breakNote = `<div class="break-note">
                       <span class="material-icons-round" style="font-size:13px;vertical-align:middle;">info</span>
                       已扣除休息 ${breakMins} 分鐘
                     </div>`;
      } else {
        // Under 4 hours — no deduction
        const hrs  = Math.floor(rawMs / 3600000);
        const mins = Math.floor((rawMs % 3600000) / 60000);
        durStr = `${hrs}h ${mins}m`;
      }
    }

    const card = document.createElement('div');
    card.className = 'history-card';
    card.dataset.id = record.id;
    card.innerHTML = `
      <div class="history-card-left">
        <div class="history-date">${record.date} ${typeTag}</div>
        <div class="history-times">
          ${timeInStr}
          <span class="material-icons-round" style="font-size:14px;margin:0 4px;">arrow_forward</span>
          ${timeOutStr}
        </div>
        ${estOutStr}
        ${breakNote}
      </div>
      <div class="history-card-right">
        <div class="history-duration">${durStr}</div>
        <button class="delete-btn" data-id="${record.id}" title="刪除此紀錄">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    `;

    // Attach delete handler
    card.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;

      if (btn.classList.contains('confirm')) {
        // Second tap — actually delete
        deleteRecord(record.id);
      } else {
        // First tap — ask for confirmation
        btn.classList.add('confirm');
        btn.querySelector('.material-icons-round').textContent = 'check';
        btn.title = '再按一次確認刪除';

        // Auto-reset after 3 seconds
        setTimeout(() => {
          if (btn.classList.contains('confirm')) {
            btn.classList.remove('confirm');
            btn.querySelector('.material-icons-round').textContent = 'delete_outline';
            btn.title = '刪除此紀錄';
          }
        }, 3000);
      }
    });

    container.appendChild(card);
  });
}

// --- Delete a single record by id ---
function deleteRecord(id) {
  state.records = state.records.filter(r => r.id !== id);
  saveData();
  updateHistoryUI();
}


// --- Navigation ---
window.switchTab = function(tabId) {
  // Update Tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  document.getElementById(`tab-${tabId}`).classList.add('active');

  if (event && event.currentTarget) {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
  }
};

// Start
document.addEventListener('DOMContentLoaded', init);


// --- Quick Time Picker Logic ---

let pickerState = {
  h: 8,
  t: 0,
  u: 0
};

window.openQuickPicker = function() {
  const picker = document.getElementById('quick-picker');
  if (!picker) return;
  
  // Try to parse current input value to sync picker
  const currentVal = document.getElementById('manual-time').value;
  if (currentVal && currentVal.includes(':')) {
    const [h, m] = currentVal.split(':').map(Number);
    pickerState.h = h;
    pickerState.t = Math.floor(m / 10);
    pickerState.u = m % 10;
  }

  syncPickerUI();
  picker.style.display = 'block';
};

window.closeQuickPicker = function() {
  const picker = document.getElementById('quick-picker');
  if (picker) picker.style.display = 'none';
};

window.pick = function(type, val) {
  pickerState[type] = val;
  
  // --- Auto-Correction Logic to enforce 06:10 ~ 10:00 ---
  if (type === 'h') {
    if (val === 6 && pickerState.t === 0) {
      pickerState.t = 1; // 06:0x -> 06:1x
    } else if (val === 10) {
      pickerState.t = 0; // 10:xx -> 10:00
      pickerState.u = 0;
    }
  } else if (type === 't') {
    // If user picks 10:x0, force units to 0
    if (pickerState.h === 10) {
      pickerState.u = 0;
    }
  }
  // -----------------------------
  
  syncPickerUI();
  updateManualTimeFromPicker();
  
  // Auto-close after picking units for speed, or if we have a full valid time
  if (type === 'u' || (pickerState.h === 10 && type === 't')) {
    setTimeout(closeQuickPicker, 150);
  }
};

function syncPickerUI() {
  const h = pickerState.h;

  // Hour
  document.querySelectorAll('#col-hour .col-item').forEach(btn => {
    const val = parseInt(btn.textContent);
    btn.classList.toggle('active', val === h);
  });
  
  // Tens
  document.querySelectorAll('#col-min-tens .col-item').forEach(btn => {
    const val = parseInt(btn.textContent) / 10;
    btn.classList.toggle('active', val === pickerState.t);
    
    // Dynamic Filtering
    if (h === 6 && val === 0) {
      btn.style.display = 'none';
    } else if (h === 10 && val > 0) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'block';
    }
  });

  // Units
  document.querySelectorAll('#col-min-units .col-item').forEach(btn => {
    const val = parseInt(btn.textContent);
    btn.classList.toggle('active', val === pickerState.u);
    
    // Dynamic Filtering
    if (h === 10 && val > 0) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'block';
    }
  });
}

function updateManualTimeFromPicker() {
  const hh = pickerState.h.toString().padStart(2, '0');
  const mm = (pickerState.t * 10 + pickerState.u).toString().padStart(2, '0');
  document.getElementById('manual-time').value = `${hh}:${mm}`;
}

// Global initialization for time input interceptor
function setupPickerInterceptor() {
  console.log('--- Attendance App: Quick Picker Initialized ---');
  const input = document.getElementById('manual-time');
  if (!input) return;

  // Intercept events to show custom picker instead of native one
  const handleTrigger = (e) => {
    if (state.workType === 'normal') {
      console.log('Picker trigger detected');
      e.preventDefault();
      e.stopPropagation();
      input.blur(); 
      openQuickPicker();
    }
  };

  // Multiple listeners for various devices
  input.addEventListener('click', handleTrigger);
  input.addEventListener('mousedown', handleTrigger);
  input.addEventListener('touchstart', handleTrigger);
  input.addEventListener('focus', handleTrigger);
  
  // Click-outside listener
  document.addEventListener('mousedown', (e) => {
    const picker = document.getElementById('quick-picker');
    const inputWrapper = document.querySelector('.time-input-wrapper');
    if (picker && picker.style.display === 'block') {
      if (!picker.contains(e.target) && !inputWrapper.contains(e.target)) {
        closeQuickPicker();
      }
    }
  });
}

// ═══════════════════════════════════════════════════════
// Google Sheets 雙向同步模組
// ═══════════════════════════════════════════════════════

/**
 * APP 開啟時呼叫：讀取試算表最後一列
 * - 若最後一列只有上班時間（無下班）→ 自動還原「上班中」狀態，帶入上班時間
 * - 若最後一列已有下班時間 → 正常顯示未打卡
 */
async function syncLoadFromSheets() {
  if (!SHEETS_API_URL) return; // 未設定 API URL，跳過
  const apiUrl = SHEETS_API_URL;
  const indicator = showSyncIndicator('讀取雲端狀態...');
  try {
    const res = await fetch(apiUrl, { method: 'GET', redirect: 'follow' });
    const data = await res.json();

    if (!data.hasData || data.clockOut) {
      // 雲端顯示最後一筆已下班或無資料
      // 【新增】如果雲端已下班，但本地還在上班中 -> 強制結束本地上班狀態
      if (state.isPunchedIn) {
        state.isPunchedIn = false;
        state.punchInTime = null;
        saveData();
        updateUI();
        updateHistoryUI();
        hideSyncIndicator(indicator, '☁️ 雲端同步：已同步為下班狀態');
      } else {
        hideSyncIndicator(indicator, '✅ 雲端同步完成');
      }
      return;
    }

    // 最後一筆只有上班時間（尚未下班）
    if (data.clockIn && !data.clockOut) {
      // 記住列號，下班時需要更新這一列
      _sheetsLastRow = data.lastRow;
      localStorage.setItem('attendance_sheets_last_row', _sheetsLastRow);

      // 若本地已經有上班中狀態，不重複覆蓋
      if (state.isPunchedIn) {
        hideSyncIndicator(indicator, '✅ 雲端同步完成');
        return;
      }

      let punchInTime;
      
      // 輔助函式：從各種亂七八糟的字串中抓出 HH:mm
      const extractTime = (str) => {
        const match = str.match(/(\d{1,2}):(\d{2})/);
        return match ? { h: parseInt(match[1]), m: parseInt(match[2]) } : null;
      };

      const timeInfo = extractTime(data.clockIn);
      if (timeInfo) {
        // 不管雲端給什麼年份，我們一律強制用「今天」的日期，配上雲端給的「時:分」
        punchInTime = new Date();
        punchInTime.setHours(timeInfo.h, timeInfo.m, 0, 0);
      }

      // 檢查解析結果是否有效
      if (!punchInTime || isNaN(punchInTime.getTime())) {
        hideSyncIndicator(indicator, '⚠️ 雲端資料解析失敗');
        return;
      }

      // 還原 workType
      const workType = data.workType === '加班' ? 'overtime' : 'normal';
      state.workType = workType;

      // 模擬打卡（帶入試算表上的時間）
      state.isPunchedIn = true;
      state.punchInTime = punchInTime;
      _notifyFired = false;

      const estimatedOut = calculatePunchOut(punchInTime, workType);
      state.records.unshift({
        id: 'sheets_' + data.lastRow,
        date: punchInTime.toLocaleDateString('zh-TW'),
        workType: workType,
        in: punchInTime,
        out: null,
        estimatedOut: estimatedOut,
        durationMs: 0
      });

      saveData();
      updateUI();
      updateHistoryUI();
      hideSyncIndicator(indicator, `☁️ 已從雲端還原：上班中 ${data.clockIn}`);
    }
  } catch (err) {
    hideSyncIndicator(indicator, '⚠️ 無法連線雲端（使用本地資料）');
    console.warn('[Sheets Sync] 讀取失敗:', err);
    // 在手機端顯示具體錯誤，方便除錯
    if (err.message.includes('Failed to fetch')) {
      alert('❌ 雲端讀取失敗：可能是 CORS 跨域問題或 API 網址錯誤。請確認部署權限為「所有人(Anyone)」。');
    } else {
      alert('❌ 雲端讀取錯誤：' + err.message);
    }
  }
}

/**
 * 上班打卡後呼叫：在試算表新增一列
 */
async function syncClockIn(record) {
  if (!SHEETS_API_URL || !record) return;
  const apiUrl = SHEETS_API_URL;
  const fmt = { hour12: false, hour: '2-digit', minute: '2-digit' };
  const payload = {
    action: 'clockIn',
    date: record.in.toLocaleDateString('zh-TW'),
    clockIn: record.in.toLocaleTimeString('zh-TW', fmt),
    workType: WORK_CONFIG[record.workType]?.label || '上班'
  };
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.lastRow) {
      _sheetsLastRow = data.lastRow;
      localStorage.setItem('attendance_sheets_last_row', _sheetsLastRow);
    }
    console.log('[Sheets Sync] 上班記錄已上傳，列號:', _sheetsLastRow);
  } catch (err) {
    console.warn('[Sheets Sync] 上班上傳失敗:', err);
    alert('❌ 上班同步失敗：' + err.message);
  }
}

/**
 * 下班打卡後呼叫：更新試算表最後一列的下班時間
 */
async function syncClockOut(record) {
  if (!SHEETS_API_URL || !record || !_sheetsLastRow) return;
  const apiUrl = SHEETS_API_URL;
  const fmt = { hour12: false, hour: '2-digit', minute: '2-digit' };
  const rawMs = record.durationMs || (record.out - record.in);
  const cfg = WORK_CONFIG[record.workType];
  const netMs = rawMs > 4 * 3600000 ? Math.max(0, rawMs - cfg.breakMins * 60000) : rawMs;
  const netHrs = Math.floor(netMs / 3600000);
  const netMins = Math.floor((netMs % 3600000) / 60000);
  const durationStr = `${netHrs}h ${netMins}m`;

  const payload = {
    action: 'clockOut',
    lastRow: _sheetsLastRow,
    clockOut: record.out.toLocaleTimeString('zh-TW', fmt),
    duration: durationStr
  };
  try {
    await fetch(apiUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    _sheetsLastRow = 0;
    localStorage.removeItem('attendance_sheets_last_row');
    console.log('[Sheets Sync] 下班記錄已更新');
  } catch (err) {
    console.warn('[Sheets Sync] 下班上傳失敗:', err);
    alert('❌ 下班同步失敗：' + err.message);
  }
}

// ─── 同步狀態提示列 ───
function showSyncIndicator(msg) {
  let el = document.getElementById('sheets-sync-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sheets-sync-indicator';
    el.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.85);color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;z-index:9999;transition:opacity 0.3s;white-space:nowrap;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.display = 'block';
  return el;
}

function hideSyncIndicator(el, finalMsg) {
  if (!el) return;
  if (finalMsg) {
    el.textContent = finalMsg;
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => { el.style.display = 'none'; }, 300); }, 2500);
  } else {
    el.style.display = 'none';
  }
}

