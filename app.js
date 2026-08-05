/*
 * Mục đích: hiển thị hàng chờ AI đề xuất ghép học viên và cho giảng viên duyệt.
 * Dữ liệu nhận vào: dữ liệu giả bên dưới khi DEMO_MODE=true, hoặc JSON từ API trung gian.
 * Xử lý: lọc theo lớp/trạng thái, hiển thị lý do AI, rồi ghi nhận quyết định trong giao diện.
 * Kết quả: bản xem thử cập nhật ngay trên màn hình; bản thật sẽ POST quyết định tới API.
 * Lỗi: hiển thị thông báo ở dải vàng phía trên, không âm thầm duyệt dữ liệu.
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
    reason: 'Tên đầy đủ trùng sau khi chuẩn hóa thứ tự họ tên.',
    status: 'pending_review'
  },
  {
    id: 'demo-review-002',
    classId: 'demo-class-01',
    className: 'Lớp mẫu A',
    erpStudentId: 'ERP-DEMO-002',
    erpStudentName: 'Trần Gia Huy',
    classroomUserId: 'google-demo-002',
    classroomName: 'Gia Huy Trần',
    classroomEmail: 'gia.huy.demo@example.com',
    confidence: 0.91,
    reason: 'Tên trùng mạnh; email không có dữ liệu đối chiếu nên cần giảng viên xác nhận.',
    status: 'pending_review'
  },
  {
    id: 'demo-review-003',
    classId: 'demo-class-02',
    className: 'Lớp mẫu B',
    erpStudentId: 'ERP-DEMO-003',
    erpStudentName: 'Lê Thu Hà',
    classroomUserId: 'google-demo-003',
    classroomName: 'Thu Hà Lê',
    classroomEmail: 'thu.ha.demo@example.com',
    confidence: 0.76,
    reason: 'Tên gần giống nhưng có hơn một ứng viên trong cùng lớp.',
    status: 'pending_review'
  }
];

const state = {
  reviews: [],
  selectedReview: null,
  approvedThisSession: 0
};

const elements = {
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
  decisionNote: document.querySelector('#decisionNote'),
  confirmDecisionButton: document.querySelector('#confirmDecisionButton')
};

function escapeHtml(value) {
  return String(value)
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
    rejected: 'Đã từ chối'
  }[status] || status;
}

function confidenceClass(confidence) {
  return confidence >= 0.9 ? 'high' : 'medium';
}

function filteredReviews() {
  const selectedClass = elements.classFilter.value;
  const selectedStatus = elements.statusFilter.value;
  const search = elements.searchInput.value.trim().toLowerCase();

  return state.reviews.filter(review => {
    const classMatches = selectedClass === 'all' || review.classId === selectedClass;
    const statusMatches = selectedStatus === 'all' || review.status === selectedStatus;
    const searchable = [review.erpStudentName, review.erpStudentId, review.classroomEmail, review.classroomName]
      .join(' ')
      .toLowerCase();
    return classMatches && statusMatches && (!search || searchable.includes(search));
  });
}

function renderFilters() {
  const classes = [...new Map(state.reviews.map(review => [review.classId, review.className])).entries()];
  elements.classFilter.innerHTML = '<option value="all">Tất cả lớp</option>' + classes
    .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
    .join('');
}

function renderSummary() {
  const pending = state.reviews.filter(review => review.status === 'pending_review').length;
  const highConfidence = state.reviews.filter(review => review.status === 'pending_review' && review.confidence >= 0.9).length;
  elements.pendingCount.textContent = pending;
  elements.highConfidenceCount.textContent = highConfidence;
  elements.approvedCount.textContent = state.approvedThisSession;
}

function renderRows() {
  const reviews = filteredReviews();
  elements.resultCount.textContent = `${reviews.length} kết quả`;
  elements.emptyState.hidden = reviews.length > 0;

  elements.reviewTableBody.innerHTML = reviews.map(review => {
    const confidence = Math.round(review.confidence * 100);
    const tone = confidenceClass(review.confidence);
    const actionButtons = review.status === 'pending_review'
      ? `<button class="button button-primary button-small" data-decision="approve" data-id="${escapeHtml(review.id)}">Duyệt</button>
         <button class="button button-danger button-small" data-decision="reject" data-id="${escapeHtml(review.id)}">Từ chối</button>`
      : '<span class="student-meta">Đã xử lý</span>';

    return `<tr>
      <td>
        <span class="student-name">${escapeHtml(review.erpStudentName)}</span>
        <span class="student-meta">Mã ERP: ${escapeHtml(review.erpStudentId)}</span>
        <span class="student-meta">Lớp: ${escapeHtml(review.className)}</span>
      </td>
      <td>
        <span class="account-name">${escapeHtml(review.classroomName)}</span>
        <span class="account-email">${escapeHtml(review.classroomEmail)}</span>
        <span class="student-meta">Google ID: ${escapeHtml(review.classroomUserId)}</span>
      </td>
      <td class="confidence">
        <div class="confidence-row"><span>AI đề xuất</span><strong class="${tone}">${confidence}%</strong></div>
        <div class="meter" aria-label="Độ tin cậy ${confidence}%"><span class="${tone}" style="width: ${confidence}%"></span></div>
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

function showNotice(message, success = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle('success', success);
}

function openDecision(review, decision) {
  state.selectedReview = { review, decision };
  elements.dialogTitle.textContent = decision === 'approve' ? 'Duyệt ghép học viên' : 'Từ chối đề xuất';
  elements.dialogSummary.textContent = `${review.erpStudentName} → ${review.classroomEmail} (${Math.round(review.confidence * 100)}% theo đề xuất AI).`;
  elements.confirmDecisionButton.textContent = decision === 'approve' ? 'Duyệt ghép' : 'Từ chối';
  elements.confirmDecisionButton.className = decision === 'approve' ? 'button button-primary' : 'button button-danger';
  elements.decisionNote.value = '';
  elements.decisionDialog.showModal();
}

async function saveDecision(review, decision, note) {
  const apiBaseUrl = window.APP_CONFIG?.API_BASE_URL || '';
  if (!apiBaseUrl || window.APP_CONFIG?.DEMO_MODE !== false) {
    review.status = decision === 'approve' ? 'approved' : 'rejected';
    if (decision === 'approve') state.approvedThisSession += 1;
    return;
  }

  const response = await fetch(`${apiBaseUrl}/api/mapping/reviews/${encodeURIComponent(review.id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ decision, note })
  });
  if (!response.ok) throw new Error(`API trả về mã ${response.status}`);
  const updated = await response.json();
  review.status = updated.status || review.status;
  if (decision === 'approve') state.approvedThisSession += 1;
}

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
    showNotice(window.APP_CONFIG?.DEMO_MODE !== false
      ? 'Đã cập nhật bản xem thử. Khi nối API thật, quyết định sẽ được ghi vào cơ sở dữ liệu sau khi xác thực giảng viên.'
      : 'Đã ghi nhận quyết định.', true);
    renderSummary();
    renderRows();
  } catch (error) {
    showNotice(`Không thể ghi nhận quyết định: ${error.message}`);
  } finally {
    elements.confirmDecisionButton.disabled = false;
  }
});

elements.statusFilter.addEventListener('change', renderRows);
elements.classFilter.addEventListener('change', renderRows);
elements.searchInput.addEventListener('input', renderRows);
elements.refreshButton.addEventListener('click', () => {
  showNotice('Bản xem thử đã làm mới. API thật sẽ tải lại hàng chờ từ máy chủ.', false);
  render();
});

async function loadReviews() {
  const apiBaseUrl = window.APP_CONFIG?.API_BASE_URL || '';
  if (!apiBaseUrl || window.APP_CONFIG?.DEMO_MODE !== false) {
    state.reviews = structuredClone(DEMO_REVIEWS);
    return;
  }

  const response = await fetch(`${apiBaseUrl}/api/mapping/reviews?status=all`, { credentials: 'include' });
  if (!response.ok) throw new Error(`Không tải được hàng chờ (mã ${response.status}).`);
  const payload = await response.json();
  state.reviews = payload.items || [];
}

loadReviews()
  .then(render)
  .catch(error => showNotice(`Không tải được dữ liệu: ${error.message}`));
