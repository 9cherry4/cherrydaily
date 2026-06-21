(() => {
  'use strict';

  const DEFAULT_DAY_START = 7 * 60;
  const DEFAULT_DAY_END = 21 * 60;
  const DEFAULT_DAY_MINUTES = DEFAULT_DAY_END - DEFAULT_DAY_START;
  const TIME_STEP = 15;
  const DEFAULT_BUFFER_MINUTES = Math.round((DEFAULT_DAY_MINUTES * 0.2) / TIME_STEP) * TIME_STEP;

  const KEYS = {
    tasks: 'harugyeol.tasks.v1',
    schedules: 'harugyeol.schedules.v4',
    settings: 'harugyeol.settings.v1'
  };

  const LABELS = {
    importance: { low: '낮음', normal: '보통', high: '높음' },
    time: { morning: '오전', afternoon: '오후', evening: '저녁', anytime: '시간 무관' },
    recurrence: { daily: '매일', weekly: '요일', monthly: '매월', yearly: '매년' },
    weekdays: ['일', '월', '화', '수', '목', '금', '토']
  };

  let tasks = readStorage(KEYS.tasks, []).map((task) => {
    const anchorText = task.deadline || localDate(task.createdAt ? new Date(task.createdAt) : new Date());
    const anchor = new Date(`${anchorText}T12:00:00`);
    return {
      ...task,
      deadline: task.deadline || '',
      startDate: task.startDate || localDate(task.createdAt ? new Date(task.createdAt) : new Date()),
      estimatedMinutes: Math.max(TIME_STEP, Math.round((task.estimatedMinutes || 60) / TIME_STEP) * TIME_STEP),
      recurrencePattern: task.recurrencePattern || (task.recurring ? 'daily' : null),
      recurrenceWeekdays: task.recurrenceWeekdays?.length ? task.recurrenceWeekdays : [anchor.getDay()],
      recurrenceMonthDay: task.recurrenceMonthDay || anchor.getDate(),
      recurrenceMonth: task.recurrenceMonth || anchor.getMonth() + 1,
      recurrenceYearDay: task.recurrenceYearDay || anchor.getDate(),
      recurrenceDates: Array.isArray(task.recurrenceDates) ? task.recurrenceDates : [],
      excludeHolidays: Boolean(task.excludeHolidays)
    };
  });
  let schedules = readStorage(KEYS.schedules, {});
  let settings = { dayStart: DEFAULT_DAY_START, dayEnd: DEFAULT_DAY_END, bufferMinutes: DEFAULT_BUFFER_MINUTES, effectiveFrom: localDate(), conditionMode: false, conditionLevel: 'normal', ...readStorage(KEYS.settings, {}) };
  let currentFilter = 'all';
  let currentTaskPeriod = 'all';
  let currentCompletedPeriod = 'all';
  let draggedScheduleId = null;
  let toastTimer = null;
  let customRecurrenceDates = [];
  let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let historyDate = addDays(localDate(), -1);
  let historyMode = 'day';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function readStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveAll() {
    localStorage.setItem(KEYS.tasks, JSON.stringify(tasks));
    localStorage.setItem(KEYS.schedules, JSON.stringify(schedules));
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  }

  function dayStart() { return Number(settings.dayStart ?? DEFAULT_DAY_START); }
  function dayEnd() { return Number(settings.dayEnd ?? DEFAULT_DAY_END); }
  function dayMinutes() { return dayEnd() - dayStart(); }
  function timeBands() {
    return {
      morning: [dayStart(), Math.min(12 * 60, dayEnd())],
      afternoon: [Math.max(12 * 60, dayStart()), Math.min(18 * 60, dayEnd())],
      evening: [Math.max(18 * 60, dayStart()), dayEnd()],
      anytime: [dayStart(), dayEnd()]
    };
  }

  function bufferMinutes() {
    return Math.min(dayMinutes() - TIME_STEP, Math.max(0, Math.round(Number(settings.bufferMinutes || 0) / TIME_STEP) * TIME_STEP));
  }

  function workLimit() {
    return dayMinutes() - bufferMinutes();
  }

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function localDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDays(dateString, amount) {
    const date = new Date(`${dateString}T12:00:00`);
    date.setDate(date.getDate() + amount);
    return localDate(date);
  }

  function formatDate(dateString, withYear = false) {
    if (!dateString) return '마감일 없음';
    const date = new Date(`${dateString}T12:00:00`);
    return new Intl.DateTimeFormat('ko-KR', {
      ...(withYear ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', weekday: 'short'
    }).format(date);
  }

  function formatCompletedDate(dateString) {
    const date = new Date(`${dateString}T12:00:00`);
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric'
    }).format(date);
  }

  function minutesToTime(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function timeToMinutes(time) {
    if (!time) return dayStart();
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
  }

  function durationText(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}분`;
    if (!rest) return `${hours}시간`;
    return `${hours}시간 ${rest}분`;
  }

  function escapeHTML(value = '') {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function daysUntil(dateString, base = localDate()) {
    const target = new Date(`${dateString}T12:00:00`);
    const from = new Date(`${base}T12:00:00`);
    return Math.round((target - from) / 86400000);
  }

  function dueText(task) {
    if (task.recurring) return recurrenceSummary(task);
    if (!task.deadline) return '마감 없음';
    const days = daysUntil(task.deadline);
    if (days < 0) return `${Math.abs(days)}일 지남`;
    if (days === 0) return '오늘 마감';
    if (days === 1) return '내일 마감';
    return `${days}일 남음`;
  }

  function priorityScore(task, date = localDate()) {
    let deadlineScore = task.recurring && repeatOccursOn(task, date) ? 250 : 0;
    if (task.deadline) {
      const days = daysUntil(task.deadline, date);
      if (days < 0) deadlineScore = 1200 + Math.abs(days) * 20;
      else if (days === 0) deadlineScore = 700;
      else deadlineScore = Math.max(0, 500 - days * 20);
    }
    const importanceScore = { high: 350, normal: 140, low: 0 }[task.importance] || 0;
    return deadlineScore + importanceScore + (task.postponedCount || 0) * 15;
  }

  function isCompletedForDate(task, date) {
    if (task.recurring) return (task.completionHistory || []).some((entry) => entry.date === date);
    return Boolean(task.completed);
  }

  function repeatOccursOn(task, date) {
    if (!task.recurring) return true;
    if (task.excludeHolidays && isKoreanHoliday(date)) return false;
    const target = new Date(`${date}T12:00:00`);
    const pattern = task.recurrencePattern || 'daily';
    if (pattern === 'daily') return true;
    if (pattern === 'weekly') return (task.recurrenceWeekdays || []).includes(target.getDay());
    if (pattern === 'monthly') return target.getDate() === Number(task.recurrenceMonthDay);
    if (pattern === 'yearly') return target.getMonth() + 1 === Number(task.recurrenceMonth) && target.getDate() === Number(task.recurrenceYearDay);
    if (pattern === 'custom') return (task.recurrenceDates || []).includes(date);
    return true;
  }

  function recurrenceSummary(task) {
    const pattern = task.recurrencePattern || 'daily';
    if (pattern === 'daily') return '매일 반복';
    if (pattern === 'weekly') {
      const days = (task.recurrenceWeekdays || []).map((day) => `${LABELS.weekdays[day]}요일`).join('·');
      return `${days || '요일 미지정'} 반복`;
    }
    if (pattern === 'monthly') return `매월 ${task.recurrenceMonthDay || 1}일 반복`;
    if (pattern === 'yearly') return `매년 ${task.recurrenceMonth || 1}월 ${task.recurrenceYearDay || 1}일 반복`;
    return `지정 날짜 ${(task.recurrenceDates || []).length}개`;
  }

  function isKoreanHoliday(dateString) {
    const date = new Date(`${dateString}T12:00:00`);
    const fixed = new Set(['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25']);
    const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (fixed.has(monthDay)) return true;
    try {
      const lunarParts = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' }).formatToParts(date);
      const lunarMonthText = lunarParts.find((part) => part.type === 'month')?.value || '';
      const lunarMonth = Number.parseInt(lunarMonthText, 10);
      const lunarDay = Number(lunarParts.find((part) => part.type === 'day')?.value);
      if (!lunarMonthText.includes('bis') && ((lunarMonth === 1 && [1, 2].includes(lunarDay)) || (lunarMonth === 4 && lunarDay === 8) || (lunarMonth === 8 && [14, 15, 16].includes(lunarDay)))) return true;
      const tomorrow = new Date(date); tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowParts = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' }).formatToParts(tomorrow);
      const nextMonth = Number.parseInt(tomorrowParts.find((part) => part.type === 'month')?.value || '', 10);
      const nextDay = Number(tomorrowParts.find((part) => part.type === 'day')?.value);
      return nextMonth === 1 && nextDay === 1;
    } catch {
      return false;
    }
  }

  function remainingMinutes(task, date) {
    if (task.recurring) return Math.max(0, task.estimatedMinutes - ((task.dailyProgress || {})[date] || 0));
    return Math.max(0, task.estimatedMinutes - (task.completedMinutes || 0));
  }

  function isEligible(task, date) {
    if (task.startDate && date < task.startDate) return false;
    if (task.deferredUntil && task.deferredUntil > date) return false;
    return repeatOccursOn(task, date) && !isCompletedForDate(task, date) && remainingMinutes(task, date) > 0;
  }

  function mergeIntervals(intervals) {
    const sorted = intervals
      .filter((item) => item.end > item.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) merged.push({ ...interval });
      else last.end = Math.max(last.end, interval.end);
    }
    return merged;
  }

  function freeIntervals(occupied, rangeStart = dayStart(), rangeEnd = dayEnd()) {
    const clipped = mergeIntervals(occupied.map((item) => ({
      start: Math.max(rangeStart, item.start), end: Math.min(rangeEnd, item.end)
    })).filter((item) => item.end > item.start));
    const free = [];
    let cursor = rangeStart;
    for (const interval of clipped) {
      if (interval.start > cursor) free.push({ start: cursor, end: interval.start });
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < rangeEnd) free.push({ start: cursor, end: rangeEnd });
    return free;
  }

  function makeScheduleItem(task, date, start, duration, type = 'task') {
    return {
      id: uid('slot'), taskId: task.id, date, type,
      title: task.title, description: task.description || '',
      start, end: start + duration, durationMinutes: duration,
      importance: task.importance, preferredTime: task.preferredTime,
      completed: false, order: 0
    };
  }

  function reserveBuffers(date, occupied, items) {
    const bandsMap = timeBands();
    const bands = [bandsMap.morning, bandsMap.afternoon, bandsMap.evening];
    const totalBuffer = bufferMinutes();
    const base = Math.floor(totalBuffer / 3 / TIME_STEP) * TIME_STEP;
    const bufferPlan = [base, base, base];
    let bufferRemainder = totalBuffer - base * 3;
    for (let index = 1; bufferRemainder > 0; index = (index + 1) % 3) {
      bufferPlan[index] += TIME_STEP;
      bufferRemainder -= TIME_STEP;
    }
    let reserved = 0;

    for (let index = 0; index < bands.length; index += 1) {
      const [bandStart, bandEnd] = bands[index];
      let needed = bufferPlan[index];
      const free = freeIntervals(occupied, bandStart, bandEnd).reverse();
      for (const interval of free) {
        if (needed <= 0) break;
        const available = Math.floor((interval.end - interval.start) / TIME_STEP) * TIME_STEP;
        const duration = Math.min(needed, available);
        if (duration < TIME_STEP) continue;
        const start = interval.end - duration;
        const buffer = {
          id: uid('buffer'), taskId: null, date, type: 'buffer',
          title: '여유 시간', description: '예상 밖의 일과 회복을 위한 빈칸',
          start, end: interval.end, durationMinutes: duration,
          completed: false, order: 0
        };
        items.push(buffer);
        occupied.push({ start: buffer.start, end: buffer.end });
        reserved += duration;
        needed -= duration;
      }
    }
    return reserved;
  }

  function generateSchedule(date = localDate(), preserveCompleted = true) {
    const previous = schedules[date]?.items || [];
    const preserved = preserveCompleted
      ? previous.filter((item) => item.completed && item.type !== 'buffer')
      : [];
    const items = preserved.map((item) => ({ ...item }));
    const occupied = items.map((item) => ({ start: item.start, end: item.end }));
    const unscheduled = [];
    const candidates = tasks.filter((task) => isEligible(task, date));

    if (!candidates.length && !preserved.length) {
      schedules[date] = { items: [], unscheduled: [], generatedAt: new Date().toISOString() };
      saveAll();
      return schedules[date];
    }

    const fixedTasks = candidates
      .filter((task) => task.isFixed)
      .sort((a, b) => timeToMinutes(a.fixedStartTime) - timeToMinutes(b.fixedStartTime) || priorityScore(b, date) - priorityScore(a, date));

    let fixedMinutes = preserved.reduce((sum, item) => sum + item.durationMinutes, 0);
    for (const task of fixedTasks) {
      const duration = remainingMinutes(task, date);
      const start = timeToMinutes(task.fixedStartTime);
      const end = start + duration;
      const overlaps = occupied.some((slot) => start < slot.end && end > slot.start);
      if (start < dayStart() || end > dayEnd()) {
        unscheduled.push({ taskId: task.id, title: task.title, reason: `일과 시간(${minutesToTime(dayStart())}~${minutesToTime(dayEnd())})을 벗어납니다.` });
      } else if (overlaps) {
        unscheduled.push({ taskId: task.id, title: task.title, reason: '다른 고정 일정과 시간이 겹칩니다.' });
      } else {
        const item = makeScheduleItem(task, date, start, duration, 'fixed');
        items.push(item);
        occupied.push({ start, end });
        fixedMinutes += duration;
      }
    }

    const reservedBuffer = reserveBuffers(date, occupied, items);
    let flexibleBudget = Math.max(0, workLimit() - fixedMinutes);
    const flexibleTasks = candidates
      .filter((task) => !task.isFixed)
      .sort((a, b) => priorityScore(b, date) - priorityScore(a, date) || (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') || a.createdAt.localeCompare(b.createdAt));

    for (const task of flexibleTasks) {
      let remaining = remainingMinutes(task, date);
      let placed = 0;
      const bandsForDay = timeBands();
      const [bandStart, bandEnd] = bandsForDay[task.preferredTime] || bandsForDay.anytime;

      if (!task.splittable) {
        if (remaining <= flexibleBudget) {
          const interval = freeIntervals(occupied, bandStart, bandEnd)
            .find((slot) => slot.end - slot.start >= remaining);
          if (interval) {
            const item = makeScheduleItem(task, date, interval.start, remaining);
            items.push(item);
            occupied.push({ start: item.start, end: item.end });
            flexibleBudget -= remaining;
            placed = remaining;
            remaining = 0;
          }
        }
      } else {
        while (remaining > 0 && flexibleBudget >= TIME_STEP) {
          const interval = freeIntervals(occupied, bandStart, bandEnd)
            .find((slot) => slot.end - slot.start >= TIME_STEP);
          if (!interval) break;
          const available = Math.floor((interval.end - interval.start) / TIME_STEP) * TIME_STEP;
          const budget = Math.floor(flexibleBudget / TIME_STEP) * TIME_STEP;
          const chunk = Math.min(60, remaining, available, budget);
          if (chunk < TIME_STEP) break;
          const item = makeScheduleItem(task, date, interval.start, chunk);
          items.push(item);
          occupied.push({ start: item.start, end: item.end });
          flexibleBudget -= chunk;
          placed += chunk;
          remaining -= chunk;
        }
      }

      if (remaining > 0) {
        let reason = placed ? `${durationText(placed)}만 배치하고 ${durationText(remaining)}이 남았습니다.` : '남은 시간에 배치할 수 없습니다.';
        if (task.preferredTime !== 'anytime' && !placed) reason = `${LABELS.time[task.preferredTime]} 시간대에 빈칸이 부족합니다.`;
        if (!task.splittable && !placed) reason = '연속된 시간이 부족합니다. 분할 가능을 켜보세요.';
        unscheduled.push({ taskId: task.id, title: task.title, reason });
      }
    }

    const mergedItems = mergeAdjacentTaskItems(items);
    mergedItems.sort((a, b) => a.start - b.start || a.end - b.end);
    mergedItems.forEach((item, index) => { item.order = index; });
    schedules[date] = {
      items: mergedItems, unscheduled, reservedBuffer,
      generatedAt: new Date().toISOString()
    };
    saveAll();
    return schedules[date];
  }

  function mergeAdjacentTaskItems(items) {
    const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const item of sorted) {
      const previous = merged[merged.length - 1];
      const joinsPrevious = previous
        && item.type === 'task'
        && previous.type === 'task'
        && item.taskId === previous.taskId
        && item.completed === previous.completed
        && previous.end === item.start;
      if (joinsPrevious) {
        previous.end = item.end;
        previous.durationMinutes += item.durationMinutes;
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }

  function showView(name) {
    $$('.view').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.viewPanel === name));
    $$('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === name));
    const titles = { today: '오늘의 흐름', add: $('#taskId').value ? '할 일 수정' : '할 일 등록', tasks: '전체 할 일', completed: '완료된 일', history: '이전 일정', settings: '설정' };
    $('#viewTitle').textContent = titles[name];
    $('#rescheduleButton').hidden = name !== 'today';
    if (name === 'tasks') renderTasks();
    if (name === 'completed') renderCompleted();
    if (name === 'today') renderToday();
    if (name === 'settings') renderSettings();
    if (name === 'history') renderHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function importanceBadges(task) {
    const badges = [];
    badges.push(`<span class="badge ${task.importance}">중요도 ${LABELS.importance[task.importance]}</span>`);
    if (task.isFixed) badges.push('<span class="badge fixed">고정</span>');
    if (task.recurring) badges.push(`<span class="badge recurring">${recurrenceSummary(task)}</span>`);
    if (task.deadline && daysUntil(task.deadline) < 0) badges.push('<span class="badge overdue">기한 지남</span>');
    return badges.join('');
  }

  function renderToday() {
    const date = localDate();
    const schedule = schedules[date] || generateSchedule(date);
    const sorted = [...schedule.items].sort((a, b) => a.order - b.order);
    const workItems = sorted.filter((item) => item.type !== 'buffer');
    const completed = workItems.filter((item) => item.completed);
    const activeWork = workItems.length;
    const percent = activeWork ? Math.round((completed.length / activeWork) * 100) : 0;
    const focusMinutes = workItems.reduce((sum, item) => sum + item.durationMinutes, 0);
    const reservedMinutes = sorted.filter((item) => item.type === 'buffer').reduce((sum, item) => sum + item.durationMinutes, 0) || bufferMinutes();

    $('#scheduleList').innerHTML = sorted.map(scheduleItemHTML).join('');
    $('#scheduleEmpty').hidden = workItems.length > 0;
    $('#scheduleList').hidden = workItems.length === 0;
    $('#scheduledCount').textContent = `${activeWork}개`;
    $('#focusTime').textContent = durationText(focusMinutes);
    $('#bufferTime').textContent = durationText(reservedMinutes);
    $('#progressPercent').textContent = `${percent}%`;
    $('#progressRing').style.setProperty('--progress', percent);
    $('#heroGreeting').textContent = percent === 100 && activeWork ? '오늘도 멋지게 마무리했어요.' : activeWork ? '차분하게, 하나씩 해볼까요?' : '오늘의 첫 흐름을 만들어 볼까요?';
    $('#heroSummary').textContent = activeWork ? `${activeWork}개의 일정과 ${durationText(reservedMinutes)}의 여유를 준비했어요.` : '할 일을 추가하면 오늘의 흐름을 자동으로 정리해 드려요.';

    const unscheduled = schedule.unscheduled || [];
    $('#unscheduledCard').hidden = !unscheduled.length;
    $('#unscheduledList').innerHTML = unscheduled.map((entry) => `<div class="mini-item"><strong>${escapeHTML(entry.title)}</strong><span>${escapeHTML(entry.reason)}</span></div>`).join('');
    attachDragEvents();
  }

  function scheduleItemHTML(item) {
    const task = item.taskId ? tasks.find((entry) => entry.id === item.taskId) : null;
    const classes = ['schedule-item', item.type, item.completed ? 'is-completed' : ''].filter(Boolean).join(' ');
    const draggable = item.type === 'task' && !item.completed;
    const subtitle = item.type === 'buffer'
      ? escapeHTML(item.description)
      : `${durationText(item.durationMinutes)} ${task?.splittable && item.type === 'task' ? '· 분할 업무' : ''}`;
    const badges = task ? `${task.importance === 'high' ? '<span class="badge high">중요</span>' : ''}${task.recurring ? `<span class="badge recurring">${escapeHTML(recurrenceSummary(task))}</span>` : ''}` : '';
    const actions = item.type === 'buffer' ? '' : item.completed ? `
      <div class="schedule-actions"><button class="icon-button" type="button" data-schedule-action="restore" data-id="${item.id}" title="완료 취소" aria-label="${escapeHTML(item.title)} 완료 취소">↶</button><span class="badge normal">완료됨</span></div>` : `
      <div class="schedule-actions">
        <button class="icon-button" type="button" data-schedule-action="edit" data-id="${item.id}" title="수정" aria-label="${escapeHTML(item.title)} 수정">✎</button>
        <button class="icon-button complete" type="button" data-schedule-action="complete" data-id="${item.id}" title="완료" aria-label="${escapeHTML(item.title)} 완료">✓</button>
        <button class="icon-button" type="button" data-schedule-action="postpone" data-id="${item.id}" title="내일로 미루기" aria-label="${escapeHTML(item.title)} 내일로 미루기">→</button>
        ${draggable ? '<span class="drag-handle" title="드래그해서 순서 변경">⠿</span>' : ''}
      </div>`;
    return `<article class="${classes}" data-schedule-id="${item.id}" draggable="${draggable}">
      <div class="schedule-time"><strong>${minutesToTime(item.start)}</strong><small>${minutesToTime(item.end)}</small></div>
      <div class="schedule-bar"></div>
      <div class="schedule-main"><h3>${escapeHTML(item.title)}</h3><p>${subtitle}${badges}</p></div>
      ${actions}
      ${item.description ? `<div class="schedule-tooltip">${escapeHTML(item.description)}</div>` : ''}
    </article>`;
  }

  function renderTasks() {
    const active = tasks
      .filter((task) => task.recurring || !task.completed)
      .filter((task) => currentFilter === 'all' || (currentFilter === 'high' && task.importance === 'high') || (currentFilter === 'fixed' && task.isFixed) || (currentFilter === 'recurring' && task.recurring))
      .filter((task) => taskMatchesPeriod(task, currentTaskPeriod))
      .sort((a, b) => priorityScore(b) - priorityScore(a));
    $('#taskList').innerHTML = active.map(taskRowHTML).join('');
    $('#tasksEmpty').hidden = active.length > 0;
    $('#taskList').hidden = active.length === 0;
    $('#activeTaskCount').textContent = tasks.filter((task) => task.recurring || !task.completed).length;
  }

  function taskRowHTML(task) {
    const completedToday = task.recurring && isCompletedForDate(task, localDate());
    const deadlineMeta = task.deadline
      ? `<span>마감 ${formatDate(task.deadline)}</span><span>·</span><span>${dueText(task)}</span>`
      : `<span>${task.recurring ? escapeHTML(recurrenceSummary(task)) : '마감 없음'}</span>`;
    return `<article class="task-row">
      <div>
        <h3>${escapeHTML(task.title)} ${completedToday ? '<span class="badge normal">오늘 완료</span>' : ''}</h3>
        ${task.description ? `<p>${escapeHTML(task.description)}</p>` : ''}
        <div class="task-meta">
          <span>시작 ${formatDate(task.startDate)}</span><span>·</span>${deadlineMeta}<span>·</span><span>${durationText(task.estimatedMinutes)}</span><span>·</span><span>${LABELS.time[task.preferredTime]}</span>
          ${importanceBadges(task)}
        </div>
      </div>
      <div class="task-actions">
        <button class="button button-ghost button-small" type="button" data-task-action="edit" data-id="${task.id}">수정</button>
        <button class="button button-ghost button-small" type="button" data-task-action="complete" data-id="${task.id}">${completedToday ? '완료됨' : '완료'}</button>
        <button class="button button-ghost button-small" type="button" data-task-action="delete" data-id="${task.id}">삭제</button>
      </div>
    </article>`;
  }

  function renderCompleted() {
    const entries = tasks.flatMap((task) => (task.completionHistory || []).map((history) => ({ task, history })))
      .filter(({ history }) => dateMatchesPeriod(history.date, currentCompletedPeriod))
      .sort((a, b) => (b.history.at || b.history.date).localeCompare(a.history.at || a.history.date));
    $('#completedList').innerHTML = entries.map(({ task, history }) => `<article class="task-row">
      <div><h3>${escapeHTML(task.title)}</h3><div class="task-meta"><span>${formatCompletedDate(history.date)} 완료</span>${task.recurring ? '<span class="badge recurring">반복 일정</span>' : ''}</div></div>
      <div class="task-actions">${task.recurring ? '' : `<button class="button button-ghost button-small" type="button" data-completed-action="restore" data-id="${task.id}">되돌리기</button>`}</div>
    </article>`).join('');
    $('#completedEmpty').hidden = entries.length > 0;
    $('#completedList').hidden = entries.length === 0;
  }

  function renderHistory() {
    const yesterday = addDays(localDate(), -1);
    if (historyDate > yesterday) historyDate = yesterday;
    const cursor = new Date(`${historyDate}T12:00:00`);
    let dates = [historyDate];
    let label = formatDate(historyDate, true);
    if (historyMode === 'week') {
      const mondayOffset = (cursor.getDay() + 6) % 7;
      const monday = new Date(cursor); monday.setDate(cursor.getDate() - mondayOffset);
      dates = Array.from({ length: 7 }, (_, index) => addDays(localDate(monday), index));
      label = `${formatDate(dates[0], true)} — ${formatDate(dates[6], true)}`;
    } else if (historyMode === 'month') {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      dates = Array.from({ length: count }, (_, index) => localDate(new Date(cursor.getFullYear(), cursor.getMonth(), index + 1)));
      label = `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
    }
    $('#historyPeriodLabel').textContent = label;
    $('#historyDatePicker').innerHTML = historyMode === 'day' ? '' : `<div class="history-date-grid">${dates.map((date) => {
      const schedule = schedules[date];
      const count = (schedule?.items || []).filter((item) => item.type !== 'buffer').length;
      const disabled = date >= localDate();
      return `<button type="button" class="history-date-button${date === historyDate ? ' is-selected' : ''}${count ? '' : ' is-empty'}" data-history-date="${date}" ${disabled ? 'disabled' : ''}><strong>${Number(date.slice(8))}일</strong><small>${count ? `${count}개 일정` : '기록 없음'}</small></button>`;
    }).join('')}</div>`;
    renderHistorySchedule(historyDate);
    $('#historyNext').disabled = historyDate >= yesterday;
  }

  function renderHistorySchedule(date) {
    const items = [...(schedules[date]?.items || [])].sort((a, b) => a.start - b.start);
    if (!items.length) {
      $('#historySchedule').innerHTML = `<div class="history-empty"><strong>${formatDate(date, true)}</strong><p>저장된 일정표가 없습니다.</p></div>`;
      return;
    }
    $('#historySchedule').innerHTML = `<div class="section-heading compact"><div><h2>${formatDate(date, true)} 일정표</h2><p>당시 저장된 일정은 변경하지 않고 그대로 표시합니다.</p></div></div><div class="schedule-list">${items.map((item) => `<article class="schedule-item ${item.type}${item.completed ? ' is-completed' : ''}"><div class="schedule-time"><strong>${minutesToTime(item.start)}</strong><small>${minutesToTime(item.end)}</small></div><div class="schedule-bar"></div><div class="schedule-main"><h3>${escapeHTML(item.title)}</h3><p>${durationText(item.durationMinutes)}${item.completed ? '<span class="badge normal">완료</span>' : ''}</p></div></article>`).join('')}</div>`;
  }

  function moveHistory(direction) {
    const cursor = new Date(`${historyDate}T12:00:00`);
    if (historyMode === 'day') cursor.setDate(cursor.getDate() + direction);
    else if (historyMode === 'week') cursor.setDate(cursor.getDate() + direction * 7);
    else cursor.setMonth(cursor.getMonth() + direction);
    historyDate = localDate(cursor);
    if (historyDate >= localDate()) historyDate = addDays(localDate(), -1);
    renderHistory();
  }

  function periodRange(period, baseDate = localDate()) {
    const base = new Date(`${baseDate}T12:00:00`);
    if (period === 'day') return { start: baseDate, end: baseDate };
    if (period === 'week') {
      const mondayOffset = (base.getDay() + 6) % 7;
      const start = new Date(base); start.setDate(base.getDate() - mondayOffset);
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { start: localDate(start), end: localDate(end) };
    }
    if (period === 'month') {
      const start = new Date(base.getFullYear(), base.getMonth(), 1);
      const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { start: localDate(start), end: localDate(end) };
    }
    return null;
  }

  function dateMatchesPeriod(date, period) {
    const range = periodRange(period);
    return !range || (date >= range.start && date <= range.end);
  }

  function taskMatchesPeriod(task, period) {
    const range = periodRange(period);
    if (!range) return true;
    if (task.recurring) {
      for (let cursor = range.start; cursor <= range.end; cursor = addDays(cursor, 1)) {
        if ((!task.startDate || cursor >= task.startDate) && repeatOccursOn(task, cursor)) return true;
      }
      return false;
    }
    if (task.deadline) return task.deadline >= range.start && task.deadline <= range.end;
    return !task.startDate || task.startDate <= range.end;
  }

  function resetForm() {
    $('#taskForm').reset();
    $('#taskId').value = '';
    setDurationControls(60);
    $('#importance').value = 'normal';
    $('#preferredTime').value = 'anytime';
    $('#splittable').checked = true;
    $('#recurrencePattern').value = 'daily';
    setWeeklyDays([new Date().getDay()]);
    $('#recurrenceMonthDay').value = String(new Date().getDate());
    $('#recurrenceMonth').value = String(new Date().getMonth() + 1);
    updateYearDayOptions(new Date().getDate());
    customRecurrenceDates = [];
    calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    $('#excludeHolidays').checked = false;
    updateRecurrenceOptions();
    renderCustomCalendar();
    $('#repeatPanel').hidden = true;
    $('#startDate').value = localDate();
    $('#deadline').value = localDate();
    setFixedStartControls(minutesToTime(dayStart()));
    $('#fixedTimePanel').hidden = true;
    $('#formTitle').textContent = '새 할 일';
    $('#submitLabel').textContent = '할 일 저장';
    $('#cancelEditButton').hidden = true;
  }

  function editTask(id) {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) return;
    $('#taskId').value = task.id;
    $('#title').value = task.title;
    $('#description').value = task.description || '';
    $('#startDate').value = task.startDate || localDate();
    $('#deadline').value = task.deadline || '';
    setDurationControls(task.estimatedMinutes);
    $('#importance').value = task.importance;
    $('#preferredTime').value = task.preferredTime;
    $('#splittable').checked = task.splittable;
    $('#recurring').checked = task.recurring;
    setRecurrenceControls(task);
    $('#repeatPanel').hidden = !task.recurring;
    $('#isFixed').checked = task.isFixed;
    setFixedStartControls(task.fixedStartTime || minutesToTime(dayStart()));
    $('#fixedTimePanel').hidden = !task.isFixed;
    $('#formTitle').textContent = '할 일 수정';
    $('#submitLabel').textContent = '수정 내용 저장';
    $('#cancelEditButton').hidden = false;
    showView('add');
    $('#title').focus();
  }

  function handleTaskSubmit(event) {
    event.preventDefault();
    const id = $('#taskId').value;
    const duration = getDurationFromControls();
    const isFixed = $('#isFixed').checked;
    const fixedStartTime = isFixed ? getFixedStartTime() : '';
    const fixedStart = timeToMinutes(fixedStartTime);

    if (duration <= 0) {
      showToast('예상 소요 시간은 최소 15분이어야 합니다.');
      $('#durationMinutes').focus();
      return;
    }
    if (duration > workLimit()) {
      showToast(`예상 소요 시간은 하루 업무 가용 시간 ${durationText(workLimit())}을 넘을 수 없습니다.`);
      $('#durationHours').focus();
      return;
    }
    if ($('#deadline').value && $('#deadline').value < $('#startDate').value) {
      showToast('마감일은 시작일보다 빠를 수 없습니다.');
      $('#deadline').focus();
      return;
    }

    if (isFixed && (fixedStart < dayStart() || fixedStart + duration > dayEnd())) {
      showToast(`고정 일정은 ${minutesToTime(dayStart())}~${minutesToTime(dayEnd())} 안에 끝나야 합니다.`);
      $('#fixedStartHour').focus();
      return;
    }

    const old = tasks.find((task) => task.id === id);
    const recurring = $('#recurring').checked;
    const recurrence = readRecurrenceControls();
    if (recurring && recurrence.recurrencePattern === 'weekly' && !recurrence.recurrenceWeekdays.length) {
      showToast('반복할 요일을 하나 이상 선택해 주세요.');
      return;
    }
    if (recurring && recurrence.recurrencePattern === 'custom' && !recurrence.recurrenceDates.length) {
      showToast('반복할 날짜를 하나 이상 선택해 주세요.');
      return;
    }
    const data = {
      id: id || uid('task'),
      title: $('#title').value.trim(),
      description: $('#description').value.trim(),
      startDate: $('#startDate').value,
      deadline: $('#deadline').value,
      estimatedMinutes: duration,
      importance: $('#importance').value,
      preferredTime: $('#preferredTime').value,
      splittable: $('#splittable').checked,
      recurring,
      recurrencePattern: recurring ? recurrence.recurrencePattern : null,
      recurrenceWeekdays: recurring ? recurrence.recurrenceWeekdays : [],
      recurrenceMonthDay: recurring ? recurrence.recurrenceMonthDay : null,
      recurrenceMonth: recurring ? recurrence.recurrenceMonth : null,
      recurrenceYearDay: recurring ? recurrence.recurrenceYearDay : null,
      recurrenceDates: recurring ? recurrence.recurrenceDates : [],
      excludeHolidays: recurring ? recurrence.excludeHolidays : false,
      isFixed,
      fixedStartTime,
      completed: old?.completed || false,
      completedMinutes: Math.min(old?.completedMinutes || 0, duration),
      dailyProgress: old?.dailyProgress || {},
      completionHistory: old?.completionHistory || [],
      createdAt: old?.createdAt || new Date().toISOString(),
      completedAt: old?.completedAt || null,
      postponedCount: old?.postponedCount || 0,
      deferredUntil: old?.deferredUntil || null
    };

    if (!data.title) return;
    if (id) tasks = tasks.map((task) => task.id === id ? data : task);
    else tasks.push(data);
    generateSchedule(localDate(), true);
    saveAll();
    resetForm();
    renderAll();
    showView('today');
    showToast(id ? '할 일을 수정하고 오늘 일정을 다시 정리했어요.' : '할 일을 저장하고 오늘 일정에 반영했어요.');
  }

  function completeScheduleItem(id) {
    const date = localDate();
    const schedule = schedules[date];
    const item = schedule?.items.find((entry) => entry.id === id);
    if (!item || item.completed || !item.taskId) return;
    const task = tasks.find((entry) => entry.id === item.taskId);
    if (!task) return;
    item.completed = true;
    item.completedAt = new Date().toISOString();

    if (task.recurring) {
      task.dailyProgress ||= {};
      task.dailyProgress[date] = Math.min(task.estimatedMinutes, (task.dailyProgress[date] || 0) + item.durationMinutes);
      if (task.dailyProgress[date] >= task.estimatedMinutes && !isCompletedForDate(task, date)) {
        task.completionHistory ||= [];
        task.completionHistory.push({ date, at: new Date().toISOString() });
        schedule.items.filter((entry) => entry.taskId === task.id).forEach((entry) => { entry.completed = true; });
      }
    } else {
      task.completedMinutes = Math.min(task.estimatedMinutes, (task.completedMinutes || 0) + item.durationMinutes);
      if (task.completedMinutes >= task.estimatedMinutes) finishTask(task, date);
    }
    saveAll();
    renderAll();
    showToast(task.completed || isCompletedForDate(task, date) ? '멋져요. 할 일을 완료했어요!' : '이 일정 조각을 완료했어요.');
  }

  function restoreScheduleItem(id) {
    const date = localDate();
    const schedule = schedules[date];
    const item = schedule?.items.find((entry) => entry.id === id);
    const task = item?.taskId ? tasks.find((entry) => entry.id === item.taskId) : null;
    if (!item || !task) return;
    schedule.items.filter((entry) => entry.taskId === task.id).forEach((entry) => {
      entry.completed = false;
      delete entry.completedAt;
    });
    task.completionHistory = (task.completionHistory || []).filter((entry) => entry.date !== date);
    if (task.recurring) {
      task.dailyProgress ||= {};
      task.dailyProgress[date] = 0;
    } else {
      task.completed = false;
      task.completedAt = null;
      task.completedMinutes = 0;
    }
    saveAll();
    renderAll();
    showToast('완료를 취소하고 미완료 일정으로 되돌렸어요.');
  }

  function finishTask(task, date = localDate()) {
    const alreadyRecorded = (task.completionHistory || []).some((entry) => entry.date === date);
    if (!task.recurring) {
      task.completed = true;
      task.completedMinutes = task.estimatedMinutes;
      task.completedAt = new Date().toISOString();
    }
    task.completionHistory ||= [];
    if (!alreadyRecorded) task.completionHistory.push({ date, at: new Date().toISOString() });
    const schedule = schedules[date];
    schedule?.items.filter((entry) => entry.taskId === task.id).forEach((entry) => {
      entry.completed = true;
      entry.completedAt ||= new Date().toISOString();
    });
  }

  function completeTask(id) {
    const task = tasks.find((entry) => entry.id === id);
    if (!task || isCompletedForDate(task, localDate())) return;
    if (task.recurring) {
      task.dailyProgress ||= {};
      task.dailyProgress[localDate()] = task.estimatedMinutes;
    }
    finishTask(task);
    saveAll();
    renderAll();
    showToast('할 일을 완료 목록으로 옮겼어요.');
  }

  function postponeTaskFromSchedule(id) {
    const date = localDate();
    const schedule = schedules[date];
    const item = schedule?.items.find((entry) => entry.id === id);
    const task = item && tasks.find((entry) => entry.id === item.taskId);
    if (!task) return;
    task.deferredUntil = addDays(date, 1);
    task.postponedCount = (task.postponedCount || 0) + 1;
    schedule.items = schedule.items.filter((entry) => entry.taskId !== task.id || entry.completed);
    schedule.unscheduled = (schedule.unscheduled || []).filter((entry) => entry.taskId !== task.id);
    schedule.items.forEach((entry, index) => { entry.order = index; });
    saveAll();
    renderAll();
    showToast('내일 다시 일정 후보에 넣어둘게요.');
  }

  async function deleteTask(id) {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) return;
    const confirmed = await confirmAction('할 일을 삭제할까요?', `“${task.title}”과 연결된 일정도 함께 삭제됩니다.`, '삭제');
    if (!confirmed) return;
    tasks = tasks.filter((entry) => entry.id !== id);
    Object.values(schedules).forEach((schedule) => {
      schedule.items = (schedule.items || []).filter((item) => item.taskId !== id);
      schedule.unscheduled = (schedule.unscheduled || []).filter((item) => item.taskId !== id);
    });
    generateSchedule(localDate(), true);
    saveAll();
    renderAll();
    showToast('할 일을 삭제했어요.');
  }

  function restoreTask(id) {
    const task = tasks.find((entry) => entry.id === id);
    if (!task || task.recurring) return;
    task.completed = false;
    task.completedAt = null;
    task.completedMinutes = 0;
    task.completionHistory = [];
    generateSchedule(localDate(), false);
    saveAll();
    renderAll();
    showView('tasks');
    showToast('미완료 할 일로 되돌렸어요.');
  }

  function attachDragEvents() {
    $$('.schedule-item[draggable="true"]').forEach((item) => {
      item.addEventListener('dragstart', () => {
        draggedScheduleId = item.dataset.scheduleId;
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
        $$('.schedule-item').forEach((entry) => entry.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (item.dataset.scheduleId !== draggedScheduleId) item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        item.classList.remove('drag-over');
        reorderSchedule(draggedScheduleId, item.dataset.scheduleId);
      });
    });
  }

  function reorderSchedule(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const schedule = schedules[localDate()];
    const ordered = [...schedule.items].sort((a, b) => a.order - b.order);
    const fromIndex = ordered.findIndex((item) => item.id === fromId);
    const toIndex = ordered.findIndex((item) => item.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = ordered.splice(fromIndex, 1);
    ordered.splice(toIndex, 0, moved);
    ordered.forEach((item, index) => { item.order = index; });
    saveAll();
    renderToday();
    showToast('실행 순서를 저장했어요. 고정 시간은 그대로 유지됩니다.');
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function confirmAction(title, message, confirmLabel = '확인') {
    const dialog = $('#confirmDialog');
    $('#dialogTitle').textContent = title;
    $('#dialogMessage').textContent = message;
    $('#dialogConfirm').textContent = confirmLabel;
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    });
  }

  function renderAll() {
    renderToday();
    renderTasks();
    renderCompleted();
  }

  function bindEvents() {
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.view === 'add') resetForm();
      showView(button.dataset.view);
    }));
    $('[data-view-link]').addEventListener('click', (event) => { event.preventDefault(); showView('today'); });
    $$('[data-go-add]').forEach((button) => button.addEventListener('click', () => { resetForm(); showView('add'); }));
    $('#taskForm').addEventListener('submit', handleTaskSubmit);
    $('#isFixed').addEventListener('change', (event) => { $('#fixedTimePanel').hidden = !event.target.checked; });
    $('#recurring').addEventListener('change', (event) => {
      $('#repeatPanel').hidden = !event.target.checked;
      if (event.target.checked) updateRecurrenceOptions();
    });
    $('#recurrencePattern').addEventListener('change', updateRecurrenceOptions);
    $('#recurrenceMonth').addEventListener('change', () => updateYearDayOptions());
    $('#calendarPrev').addEventListener('click', () => moveCalendar(-1));
    $('#calendarNext').addEventListener('click', () => moveCalendar(1));
    $('#calendarMonthToggle').addEventListener('click', () => { $('#calendarJump').hidden = !$('#calendarJump').hidden; });
    $('#calendarYearSelect').addEventListener('change', jumpCalendarToSelection);
    $('#calendarMonthSelect').addEventListener('change', jumpCalendarToSelection);
    $('#customCalendarGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-calendar-date]');
      if (button) toggleCustomDate(button.dataset.calendarDate);
    });
    $('#bufferHours').addEventListener('change', renderBufferSettingSummary);
    $('#bufferMinutes').addEventListener('change', renderBufferSettingSummary);
    $('#workStartHour').addEventListener('change', previewWorkTimeChange);
    $('#workStartMinute').addEventListener('change', previewWorkTimeChange);
    $('#workEndHour').addEventListener('change', previewWorkTimeChange);
    $('#workEndMinute').addEventListener('change', previewWorkTimeChange);
    $('#conditionMode').addEventListener('change', updateConditionControls);
    $('#conditionLevel').addEventListener('change', updateConditionControls);
    $('#saveSettingsButton').addEventListener('click', saveSettingsFromForm);
    $('#historyPrev').addEventListener('click', () => moveHistory(-1));
    $('#historyNext').addEventListener('click', () => moveHistory(1));
    $('#historyDatePicker').addEventListener('click', (event) => {
      const button = event.target.closest('[data-history-date]');
      if (!button || button.disabled) return;
      historyDate = button.dataset.historyDate;
      renderHistory();
    });
    $('#clearFormButton').addEventListener('click', resetForm);
    $('#cancelEditButton').addEventListener('click', () => { resetForm(); showView('tasks'); });
    $('#rescheduleButton').addEventListener('click', () => {
      generateSchedule(localDate(), true);
      renderAll();
      showToast('완료한 일정과 고정 시간을 지키며 다시 배치했어요.');
    });

    $('#scheduleList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-schedule-action]');
      if (!button) return;
      if (button.dataset.scheduleAction === 'edit') {
        const item = schedules[localDate()]?.items.find((entry) => entry.id === button.dataset.id);
        if (item?.taskId) editTask(item.taskId);
      }
      if (button.dataset.scheduleAction === 'complete') completeScheduleItem(button.dataset.id);
      if (button.dataset.scheduleAction === 'restore') restoreScheduleItem(button.dataset.id);
      if (button.dataset.scheduleAction === 'postpone') postponeTaskFromSchedule(button.dataset.id);
    });

    $('#taskList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-task-action]');
      if (!button) return;
      const { taskAction, id } = button.dataset;
      if (taskAction === 'edit') editTask(id);
      if (taskAction === 'complete') completeTask(id);
      if (taskAction === 'delete') deleteTask(id);
    });

    $('#completedList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-completed-action="restore"]');
      if (button) restoreTask(button.dataset.id);
    });

    $$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
      currentFilter = button.dataset.filter;
      $$('[data-filter]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      renderTasks();
    }));
    $$('[data-task-period]').forEach((button) => button.addEventListener('click', () => {
      currentTaskPeriod = button.dataset.taskPeriod;
      $$('[data-task-period]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      renderTasks();
    }));
    $$('[data-completed-period]').forEach((button) => button.addEventListener('click', () => {
      currentCompletedPeriod = button.dataset.completedPeriod;
      $$('[data-completed-period]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      renderCompleted();
    }));
    $$('[data-history-mode]').forEach((button) => button.addEventListener('click', () => {
      historyMode = button.dataset.historyMode;
      $$('[data-history-mode]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      renderHistory();
    }));
  }

  function getDurationFromControls() {
    return Number($('#durationHours').value) * 60 + Number($('#durationMinutes').value);
  }

  function setDurationControls(value) {
    const normalized = Math.min(workLimit(), Math.max(0, Math.round(Number(value || 0) / TIME_STEP) * TIME_STEP));
    $('#durationHours').value = String(Math.floor(normalized / 60));
    $('#durationMinutes').value = String(normalized % 60);
  }

  function populateDurationHours() {
    const selected = Number($('#durationHours')?.value || 1);
    const maximum = Math.floor(workLimit() / 60);
    $('#durationHours').innerHTML = Array.from({ length: maximum + 1 }, (_, hour) => `<option value="${hour}">${hour}시간</option>`).join('');
    $('#durationHours').value = String(Math.min(selected, maximum));
    $('#durationHint').textContent = `최소 15분 · 하루 업무 가용 시간 ${durationText(workLimit())} 이내`;
  }

  function timeOptions(startHour = 0, endHour = 23) {
    return Array.from({ length: endHour - startHour + 1 }, (_, index) => {
      const hour = startHour + index;
      return `<option value="${hour}">${String(hour).padStart(2, '0')}시</option>`;
    }).join('');
  }

  function populateTimeControls() {
    $('#workStartHour').innerHTML = timeOptions(0, 23);
    $('#workEndHour').innerHTML = timeOptions(0, 23);
    const minuteOptions = [0, 15, 30, 45].map((minute) => `<option value="${minute}">${String(minute).padStart(2, '0')}분</option>`).join('');
    $('#workStartMinute').innerHTML = minuteOptions;
    $('#workEndMinute').innerHTML = minuteOptions;
    populateFixedStartHours();
  }

  function populateFixedStartHours() {
    const current = Number($('#fixedStartHour')?.value || Math.floor(dayStart() / 60));
    const first = Math.floor(dayStart() / 60);
    const last = Math.floor((dayEnd() - TIME_STEP) / 60);
    $('#fixedStartHour').innerHTML = timeOptions(first, last);
    $('#fixedStartHour').value = String(Math.min(last, Math.max(first, current)));
    $('#fixedTimeHint').textContent = `${minutesToTime(dayStart())}부터 ${minutesToTime(dayEnd())} 사이에 끝나도록 입력해 주세요.`;
  }

  function setTimeControls(prefix, minutes) {
    $(`#${prefix}Hour`).value = String(Math.floor(minutes / 60));
    $(`#${prefix}Minute`).value = String(minutes % 60);
  }

  function getTimeControls(prefix) {
    return Number($(`#${prefix}Hour`).value) * 60 + Number($(`#${prefix}Minute`).value);
  }

  function setFixedStartControls(time) {
    const value = timeToMinutes(time);
    setTimeControls('fixedStart', Math.min(dayEnd() - TIME_STEP, Math.max(dayStart(), value)));
  }

  function getFixedStartTime() {
    return minutesToTime(getTimeControls('fixedStart'));
  }

  function populateBufferControls() {
    $('#bufferHours').innerHTML = Array.from({ length: 14 }, (_, hour) => `<option value="${hour}">${hour}시간</option>`).join('');
  }

  function setBufferControls(minutes) {
    const normalized = Math.min(dayMinutes() - TIME_STEP, Math.max(0, Math.round(Number(minutes || 0) / TIME_STEP) * TIME_STEP));
    $('#bufferHours').value = String(Math.floor(normalized / 60));
    $('#bufferMinutes').value = String(normalized % 60);
    renderBufferSettingSummary();
  }

  function selectedBufferMinutes() {
    return Number($('#bufferHours').value) * 60 + Number($('#bufferMinutes').value);
  }

  function renderBufferSettingSummary() {
    const value = selectedBufferMinutes();
    $('#bufferSettingSummary').textContent = `업무 가용 시간 ${durationText(dayMinutes() - value)} · 15분 단위`;
  }

  function renderSettings() {
    setTimeControls('workStart', dayStart());
    setTimeControls('workEnd', dayEnd());
    $('#conditionMode').checked = Boolean(settings.conditionMode);
    $('#conditionLevel').value = settings.conditionLevel || 'normal';
    $('#conditionPanel').hidden = !settings.conditionMode;
    setBufferControls(bufferMinutes());
    setBufferControlsDisabled(Boolean(settings.conditionMode));
    if (settings.conditionMode) updateConditionControls();
  }

  function conditionRatio(level) {
    return { good: 0.1, normal: 0.2, tired: 0.3, pms: 0.25 }[level] ?? 0.2;
  }

  function automaticBufferFor(dayLength, conditionEnabled = $('#conditionMode').checked, level = $('#conditionLevel').value) {
    const ratio = conditionEnabled ? conditionRatio(level) : 0.2;
    return Math.round((dayLength * ratio) / TIME_STEP) * TIME_STEP;
  }

  function setBufferControlsDisabled(disabled) {
    $('#bufferHours').disabled = disabled;
    $('#bufferMinutes').disabled = disabled;
  }

  function updateConditionControls() {
    const enabled = $('#conditionMode').checked;
    $('#conditionPanel').hidden = !enabled;
    setBufferControlsDisabled(enabled);
    const start = getTimeControls('workStart');
    const end = getTimeControls('workEnd');
    if (end > start) setBufferControls(automaticBufferFor(end - start, enabled, $('#conditionLevel').value));
    const modeLabel = enabled ? $('#conditionLevel').options[$('#conditionLevel').selectedIndex].text.split(' · ')[0] : '수동';
    $('#bufferSettingSummary').textContent = `${modeLabel} 모드 · 여유 시간 ${durationText(selectedBufferMinutes())}`;
  }

  function previewWorkTimeChange() {
    const start = getTimeControls('workStart');
    const end = getTimeControls('workEnd');
    if (end <= start) {
      $('#bufferSettingSummary').textContent = '종료 시간은 시작 시간보다 늦어야 합니다.';
      return;
    }
    const automaticBuffer = automaticBufferFor(end - start);
    const hours = Math.floor(automaticBuffer / 60);
    $('#bufferHours').value = String(Math.min(13, hours));
    $('#bufferMinutes').value = String(automaticBuffer % 60);
    $('#bufferSettingSummary').textContent = `일과 시간과 컨디션에 맞춰 여유 시간 ${durationText(automaticBuffer)}으로 자동 조정`;
  }

  function applySettingsText() {
    const value = durationText(bufferMinutes());
    const ratio = Math.round((bufferMinutes() / dayMinutes()) * 100);
    const sideText = $('.sidebar-note p');
    if (sideText) sideText.textContent = `하루의 ${ratio}%인 ${value}을 예상 밖의 일을 위해 비워둡니다.`;
    const ruleText = $('.day-rule small');
    if (ruleText) ruleText.textContent = `여유 시간 ${value} · 설정 탭에서 변경 가능`;
    const dayRule = $('.day-rule strong');
    if (dayRule) dayRule.textContent = `${minutesToTime(dayStart())} — ${minutesToTime(dayEnd())}`;
  }

  function saveSettingsFromForm() {
    const value = selectedBufferMinutes();
    const newStart = getTimeControls('workStart');
    const newEnd = getTimeControls('workEnd');
    if (newEnd - newStart < 60) {
      showToast('일과 시간은 최소 1시간 이상이어야 합니다.');
      return;
    }
    if (value >= newEnd - newStart) {
      showToast('여유 시간은 일과 시간보다 짧아야 합니다.');
      return;
    }
    settings.dayStart = newStart;
    settings.dayEnd = newEnd;
    settings.bufferMinutes = value;
    settings.conditionMode = $('#conditionMode').checked;
    settings.conditionLevel = $('#conditionLevel').value;
    settings.effectiveFrom = localDate();
    populateFixedStartHours();
    populateDurationHours();
    applySettingsText();
    generateSchedule(localDate(), true);
    saveAll();
    renderAll();
    renderSettings();
    showToast('여유 시간을 저장하고 오늘 일정을 다시 만들었어요.');
  }

  function populateRecurrenceControls() {
    $('#recurrenceMonthDay').innerHTML = Array.from({ length: 31 }, (_, index) => `<option value="${index + 1}">${index + 1}일</option>`).join('');
    $('#recurrenceMonth').innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1}월</option>`).join('');
    const currentYear = new Date().getFullYear();
    $('#calendarYearSelect').innerHTML = Array.from({ length: 21 }, (_, index) => `<option value="${currentYear - 10 + index}">${currentYear - 10 + index}년</option>`).join('');
    $('#calendarMonthSelect').innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index}">${index + 1}월</option>`).join('');
    updateYearDayOptions();
  }

  function daysInSelectedMonth(month) {
    return new Date(2024, Number(month), 0).getDate();
  }

  function updateYearDayOptions(preferredDay) {
    const select = $('#recurrenceYearDay');
    const previous = Number(preferredDay || select.value || new Date().getDate());
    const maximum = daysInSelectedMonth($('#recurrenceMonth').value || 1);
    select.innerHTML = Array.from({ length: maximum }, (_, index) => `<option value="${index + 1}">${index + 1}일</option>`).join('');
    select.value = String(Math.min(previous, maximum));
  }

  function updateRecurrenceOptions() {
    const pattern = $('#recurrencePattern').value;
    $('#dailyOptions').hidden = pattern !== 'daily';
    $('#weeklyOptions').hidden = pattern !== 'weekly';
    $('#monthlyOptions').hidden = pattern !== 'monthly';
    $('#yearlyOptions').hidden = pattern !== 'yearly';
    $('#customOptions').hidden = pattern !== 'custom';
    if (pattern === 'custom') renderCustomCalendar();
  }

  function setWeeklyDays(days) {
    const selected = new Set((days || []).map(Number));
    $$('input[name="recurrenceWeekday"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
  }

  function readRecurrenceControls() {
    return {
      recurrencePattern: $('#recurrencePattern').value,
      recurrenceWeekdays: $$('input[name="recurrenceWeekday"]:checked').map((input) => Number(input.value)),
      recurrenceMonthDay: Number($('#recurrenceMonthDay').value),
      recurrenceMonth: Number($('#recurrenceMonth').value),
      recurrenceYearDay: Number($('#recurrenceYearDay').value),
      recurrenceDates: [...customRecurrenceDates].sort(),
      excludeHolidays: $('#excludeHolidays').checked
    };
  }

  function setRecurrenceControls(task) {
    $('#recurrencePattern').value = task.recurrencePattern || 'daily';
    setWeeklyDays(task.recurrenceWeekdays || [new Date().getDay()]);
    $('#recurrenceMonthDay').value = String(task.recurrenceMonthDay || new Date().getDate());
    $('#recurrenceMonth').value = String(task.recurrenceMonth || new Date().getMonth() + 1);
    updateYearDayOptions(task.recurrenceYearDay || new Date().getDate());
    customRecurrenceDates = [...(task.recurrenceDates || [])];
    $('#excludeHolidays').checked = Boolean(task.excludeHolidays);
    if (customRecurrenceDates.length) {
      const first = new Date(`${customRecurrenceDates[0]}T12:00:00`);
      calendarCursor = new Date(first.getFullYear(), first.getMonth(), 1);
    }
    updateRecurrenceOptions();
    renderCustomCalendar();
  }

  function moveCalendar(monthDelta) {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + monthDelta, 1);
    renderCustomCalendar();
  }

  function jumpCalendarToSelection() {
    calendarCursor = new Date(Number($('#calendarYearSelect').value), Number($('#calendarMonthSelect').value), 1);
    $('#calendarJump').hidden = true;
    renderCustomCalendar();
  }

  function renderCustomCalendar() {
    if (!$('#customCalendarGrid')) return;
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    $('#customCalendarTitle').textContent = `${year}년 ${month + 1}월`;
    $('#calendarYearSelect').value = String(year);
    $('#calendarMonthSelect').value = String(month);
    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    const cells = Array.from({ length: firstDay }, () => '<span class="calendar-day-placeholder"></span>');
    for (let day = 1; day <= lastDate; day += 1) {
      const date = localDate(new Date(year, month, day));
      const selected = customRecurrenceDates.includes(date);
      const holiday = isKoreanHoliday(date);
      cells.push(`<button class="calendar-day${selected ? ' is-selected' : ''}${holiday ? ' is-holiday' : ''}" type="button" data-calendar-date="${date}" aria-pressed="${selected}">${day}</button>`);
    }
    $('#customCalendarGrid').innerHTML = cells.join('');
    const preview = [...customRecurrenceDates].sort();
    $('#selectedDateSummary').textContent = preview.length
      ? `${preview.length}개 선택 · ${preview.slice(0, 3).map((date) => date.slice(5).replace('-', '/')).join(', ')}${preview.length > 3 ? ' 외' : ''}`
      : '선택한 날짜가 없습니다.';
  }

  function toggleCustomDate(date) {
    customRecurrenceDates = customRecurrenceDates.includes(date)
      ? customRecurrenceDates.filter((entry) => entry !== date)
      : [...customRecurrenceDates, date];
    renderCustomCalendar();
  }

  function init() {
    const now = new Date();
    $('#todayEyebrow').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
    populateDurationHours();
    populateBufferControls();
    populateTimeControls();
    populateRecurrenceControls();
    resetForm();
    applySettingsText();
    if (!schedules[localDate()]) generateSchedule(localDate());
    bindEvents();
    renderAll();
  }

  init();
})();
