/*
 * Mục đích: tải hàng chờ mapping và cho giảng viên duyệt trên trình duyệt.
 * Dữ liệu nhận vào: mã truy cập, tên người duyệt và JSON từ API n8n; bản xem thử dùng dữ liệu giả.
 * Xử lý: lọc danh sách, hiển thị gợi ý, cho phép chọn tài khoản khác rồi gửi quyết định có xác thực.
 * Kết quả: PostgreSQL chỉ nhận mapping sau khi API xác nhận; giao diện tải lại trạng thái mới nhất.
 * Lỗi: hiện thông báo rõ, không tự coi yêu cầu thất bại là đã duyệt.
 */

const DEMO_REVIEWS = [
  {
    id: 'demo-review-001',
    classId: 'demo-class-01',
    className: 'Lớp mẫu A',
    erpStudentId: 'ERP-DEMO-001',
    erpStudentName: 'Nguyễn Minh Anh',
    classroomUserId: 'google-demo-001',
    classroomName: 'Minh Anh Nguyễn',
    classroomEmail: 'minh.anh.demo@example.com',
    confidence: 0.98,
    reason: 'Tên đầy đủ trùng sau khi chuẩn hóa.',
    status: 'pending_review',
    candidates: [
      { userId: 'google-demo-001', fullName: 'Minh Anh Nguyễn', email: 'minh.anh.demo@example.com' },
      { userId: 'google-demo-004', fullName: 'Nguyễn Anh Minh', email: 'anh.minh.demo@example.com' }
    ]
  },
  {
    id: 'demo-review-002',
    classId: 'demo-class-01',
    className: 'Lớp mẫu A',
    erpStudentId: 'ERP-DEMO-002',
    erpStudentName: 'Trần Gia Huy',
    classroomUserId: null,
    classroomName: null,
    classroomEmail: null,
    confidence: 0,
    reason: 'Chưa có ứng viên đủ rõ ràng; giảng viên cần chọn thủ công.',
    status: 'pending_review',
    candidates: [
      { userId: 'google-demo-002', fullName: 'Gia Huy Trần', email: 'gia.huy.demo@example.com' },
      { userId: 'google-demo-003', fullName: 'Trần Minh Huy', email: 'minh.huy.demo@example.com' }
    ]
  }
];

const isDemo = window.APP_CONFIG?.DEMO_MODE !== false;
const state = {
  reviews: [],
  selectedReview: null,
  approvedThisSession: 0,
  accessCode: sessionStorage.getItem('mappingReviewAccessCode') || '',
  reviewerName: sessionStorage.getItem('mappingReviewerName') || '',
  connected: isDemo
};

const elements = {
  accessPanel: document.querySelector('#accessPanel'),
  accessCode: document.querySelector('#accessCode'),
  reviewerName: document.querySelector('#reviewerName'),
  connectButton: document.querySelector('#connectButton'),
  modeBadge: document.querySelector('#modeBadge'),
  classFilter: document.querySelector('#classFilter'),
  statusFilter: document.querySelector('#statusFilter'),
  searchInput: document.querySelector('#searchInput'),
  reviewTableBody: document.querySelector('#reviewTableBody'),
  emptyState: document.querySelector('#emptyState'),
  resultCount: document.querySelector('#resultCount'),
  pendingCount: document.querySelector('#pendingCount'),
  highConfidenceCount: document.querySelector('#highConfidenceCount'),
  approvedCount: document.querySelector('#approvedCount'),
  notice: document.querySelector('#notice'),
  refreshButton: document.querySelector('#refreshButton'),
  decisionDialog: document.querySelector('#decisionDialog'),
  decisionForm: document.querySelector('#decisionForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  dialogSummary: document.querySelector('#dialogSummary'),
  alternateAccountField: document.querySelector('#alternateAccountField'),
  alternateAccountSelect: document.querySelector('#alternateAccountSelect'),
  decisionNote: document.querySelector('#decisionNote'),
  confirmDecisionButton: document.querySelector('#confirmDecisionButton')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusLabel(status) {
  return {
    pending_review: 'Chờ giảng viên duyệt',
    approved: 'Đã duyệt',
    rejected: 'Đã từ chối',
    superseded: 'Không còn trong lớp'
  }[status] || status;
}

function confidenceClass(confidence) {
  return Number(confidence) >= 0.9 ? 'high' : 'medium';
}

function showNotice(message, success = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle('success', success);
}

function updateConnectionUi() {
  elements.accessCode.value = state.accessCode;
  elements.reviewerName.value = state.reviewerName;
  elements.accessPanel.classList.toggle('connected', state.connected && !isDemo);
  elements.modeBadge.textContent = isDemo
    ? 'Bản xem thử'
    : state.connected ? 'Đã kết nối' : 'Chưa kết nối';
  elements.connectButton.textContent = state.connected && !isDemo ? 'Kết nối lại' : 'Kết nối';
  if (isDemo) elements.accessPanel.hidden = true;
}

function filteredReviews() {
  const selectedClass = elements.classFilter.value;
  const selectedStatus = elements.statusFilter.value;
  const search = elements.searchInput.value.trim().toLowerCase();

  return state.reviews.filter(review => {
    const classMatches = selectedClass === 'all' || review.classId === selectedClass;
    const statusMatches = selectedStatus === 'all' || review.status === selectedStatus;
    const searchable = [
      review.erpStudentName,
      review.erpStudentId,
      review.classroomEmail,
      review.classroomName
    ].join(' ').toLowerCase();
    return classMatches && statusMatches && (!search || searchable.includes(search));
  });
}

function renderFilters() {
  const previousValue = elements.classFilter.value || 'all';
  const classes = [...new Map(state.reviews.map(review => [review.classId, review.className])).entries()];
  elements.classFilter.innerHTML = '<option value="all">Tất cả lớp</option>' + classes
    .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
    .join('');
  elements.classFilter.value = classes.some(([id]) => id === previousValue) ? previousValue : 'all';
}

function renderSummary() {
  const pending = state.reviews.filter(review => review.status === 'pending_review').length;
  const highConfidence = state.reviews.filter(review =>
    review.status === 'pending_review' && review.classroomUserId && Number(review.confidence) >= 0.9
  ).length;
  elements.pendingCount.textContent = pending;
  elements.highConfidenceCount.textContent = highConfidence;
  elements.approvedCount.textContent = state.approvedThisSession;
}

function renderRows() {
  const reviews = filteredReviews();
  elements.resultCount.textContent = `${reviews.length} kết quả`;
  elements.emptyState.hidden = reviews.length > 0;

  elements.reviewTableBody.innerHTML = reviews.map(review => {
    const confidence = Math.round(Number(review.confidence || 0) * 100);
    const tone = confidenceClass(review.confidence);
    const hasSuggestion = Boolean(review.classroomUserId);
    const accountBlock = hasSuggestion
      ? `<span class="account-name">${escapeHtml(review.classroomName)}</span>
         <span class="account-email">${escapeHtml(review.classroomEmail)}</span>
         <span class="student-meta">Google ID: ${escapeHtml(review.classroomUserId)}</span>`
      : `<span class="account-name">Chưa có gợi ý rõ</span>
         <span class="account-email">Giảng viên chọn từ roster hiện tại của lớp.</span>`;
    const confidenceBlock = hasSuggestion
      ? `<div class="confidence-row"><span>Gợi ý tự động</span><strong class="${tone}">${confidence}%</strong></div>
         <div class="meter" aria-label="Độ tin cậy ${confidence}%"><span class="${tone}" style="width: ${confidence}%"></span></div>`
      : '<div class="confidence-row"><span>Cần chọn thủ công</span><strong class="medium">—</strong></div>';
    const actionButtons = review.status === 'pending_review'
      ? `${hasSuggestion ? `<button class="button button-primary button-small" data-decision="approve" data-id="${escapeHtml(review.id)}">Duyệt</button>` : ''}
         <button class="button button-secondary button-small" data-decision="choose_another" data-id="${escapeHtml(review.id)}">${hasSuggestion ? 'Đổi tài khoản' : 'Chọn tài khoản'}</button>
         <button class="button button-danger button-small" data-decision="reject" data-id="${escapeHtml(review.id)}">Từ chối</button>`
      : '<span class="student-meta">Đã xử lý</span>';

    return `<tr>
      <td>
        <span class="student-name">${escapeHtml(review.erpStudentName)}</span>
        <span class="student-meta">Mã ERP: ${escapeHtml(review.erpStudentId)}</span>
        <span class="student-meta">Lớp: ${escapeHtml(review.className)}</span>
      </td>
      <td>${accountBlock}</td>
      <td class="confidence">
        ${confidenceBlock}
        <span class="reason">${escapeHtml(review.reason)}</span>
      </td>
      <td><span class="status status-${escapeHtml(review.status)}">${escapeHtml(statusLabel(review.status))}</span></td>
      <td><div class="actions">${actionButtons}</div></td>
    </tr>`;
  }).join('');
}

function render() {
  renderFilters();
  renderSummary();
  renderRows();
}

async function apiRequest(path, options = {}) {
  const apiBaseUrl = window.APP_CONFIG?.API_BASE_URL || '';
  if (!apiBaseUrl) throw new Error('Chưa cấu hình địa chỉ API.');
  if (!state.accessCode) throw new Error('Bạn chưa nhập mã truy cập.');

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'x-review-token': state.accessCode,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 403
    ? 'Mã truy cập không đúng hoặc đã hết hiệu lực.'
    : `API trả về mã ${response.status}.`);
  if (!payload?.ok) throw new Error(payload?.message || payload?.error || 'API không xác nhận yêu cầu.');
  return payload;
}

async function loadReviews() {
  if (isDemo) {
    state.reviews = structuredClone(DEMO_REVIEWS);
    return;
  }

  const payload = await apiRequest('/api/mapping/reviews?status=all');
  state.reviews = payload.items || [];
  state.connected = true;
}

function openDecision(review, decision) {
  if (!isDemo && !state.reviewerName) {
    showNotice('Hãy nhập tên người duyệt và kết nối lại trước khi xác nhận.');
    elements.reviewerName.focus();
    return;
  }

  state.selectedReview = { review, decision };
  const choosingAnother = decision === 'choose_another';
  elements.dialogTitle.textContent = {
    approve: 'Duyệt ghép học viên',
    reject: 'Từ chối đề xuất',
    choose_another: 'Chọn tài khoản Classroom đúng'
  }[decision];
  elements.dialogSummary.textContent = decision === 'reject'
    ? `${review.erpStudentName}: từ chối gợi ý hiện tại.`
    : `${review.erpStudentName} → ${review.classroomEmail || 'chưa chọn tài khoản'}.`;
  elements.alternateAccountField.hidden = !choosingAnother;
  elements.alternateAccountSelect.innerHTML = (review.candidates || [])
    .map(candidate => `<option value="${escapeHtml(candidate.userId)}">${escapeHtml(candidate.fullName)} — ${escapeHtml(candidate.email)}</option>`)
    .join('');
  if (choosingAnother && review.classroomUserId) {
    elements.alternateAccountSelect.value = review.classroomUserId;
  }
  elements.confirmDecisionButton.textContent = decision === 'reject' ? 'Từ chối' : 'Xác nhận mapping';
  elements.confirmDecisionButton.className = decision === 'reject' ? 'button button-danger' : 'button button-primary';
  elements.decisionNote.value = '';
  elements.decisionDialog.showModal();
}

async function saveDecision(review, decision, note) {
  const classroomUserId = decision === 'choose_another' ? elements.alternateAccountSelect.value : undefined;
  if (decision === 'choose_another' && !classroomUserId) {
    throw new Error('Lớp chưa có tài khoản Classroom để chọn.');
  }

  if (isDemo) {
    review.status = decision === 'reject' ? 'rejected' : 'approved';
    if (decision !== 'reject') state.approvedThisSession += 1;
    return;
  }

  await apiRequest('/api/mapping/reviews/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewId: review.id,
      decision,
      classroomUserId,
      note,
      reviewerName: state.reviewerName
    })
  });
  if (decision !== 'reject') state.approvedThisSession += 1;
  await loadReviews();
}

elements.connectButton.addEventListener('click', async () => {
  state.accessCode = elements.accessCode.value.trim();
  state.reviewerName = elements.reviewerName.value.trim();
  if (!state.accessCode || !state.reviewerName) {
    showNotice('Hãy nhập đủ tên người duyệt và mã truy cập.');
    return;
  }

  elements.connectButton.disabled = true;
  try {
    sessionStorage.setItem('mappingReviewAccessCode', state.accessCode);
    sessionStorage.setItem('mappingReviewerName', state.reviewerName);
    await loadReviews();
    updateConnectionUi();
    render();
    showNotice(`Đã tải ${state.reviews.length} phiếu duyệt.`, true);
  } catch (error) {
    state.connected = false;
    updateConnectionUi();
    showNotice(`Không thể kết nối: ${error.message}`);
  } finally {
    elements.connectButton.disabled = false;
  }
});

elements.reviewTableBody.addEventListener('click', event => {
  const button = event.target.closest('[data-decision]');
  if (!button) return;
  const review = state.reviews.find(item => item.id === button.dataset.id);
  if (review) openDecision(review, button.dataset.decision);
});

elements.decisionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedReview) return;
  const { review, decision } = state.selectedReview;
  elements.confirmDecisionButton.disabled = true;
  try {
    await saveDecision(review, decision, elements.decisionNote.value.trim());
    elements.decisionDialog.close();
    showNotice(isDemo
      ? 'Đã cập nhật bản xem thử; chưa ghi vào cơ sở dữ liệu.'
      : 'Đã ghi quyết định và cập nhật mapping chính thức.', true);
    render();
  } catch (error) {
    showNotice(`Không thể ghi nhận quyết định: ${error.message}`);
  } finally {
    elements.confirmDecisionButton.disabled = false;
  }
});

elements.statusFilter.addEventListener('change', renderRows);
elements.classFilter.addEventListener('change', renderRows);
elements.searchInput.addEventListener('input', renderRows);
elements.refreshButton.addEventListener('click', async () => {
  elements.refreshButton.disabled = true;
  try {
    await loadReviews();
    render();
    showNotice(isDemo ? 'Đã làm mới dữ liệu mẫu.' : 'Đã tải lại hàng chờ mới nhất.', true);
  } catch (error) {
    showNotice(`Không thể làm mới: ${error.message}`);
  } finally {
    elements.refreshButton.disabled = false;
  }
});

updateConnectionUi();
if (isDemo) {
  loadReviews().then(render).catch(error => showNotice(`Không tải được dữ liệu mẫu: ${error.message}`));
} else if (state.accessCode && state.reviewerName) {
  loadReviews()
    .then(() => {
      updateConnectionUi();
      render();
      showNotice(`Đã tải ${state.reviews.length} phiếu duyệt.`, true);
    })
    .catch(error => {
      state.connected = false;
      updateConnectionUi();
      showNotice(`Hãy kết nối lại: ${error.message}`);
    });
} else {
  render();
  showNotice('Nhập tên người duyệt và mã truy cập để tải dữ liệu thật.');
}
