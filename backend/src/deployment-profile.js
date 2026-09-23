// Dữ liệu vào: tên profile do từng service truyền qua biến môi trường.
// Việc chính: gom các khác biệt vận hành K56/K67 vào một cấu hình bất biến.
// Kết quả: cùng một image chạy đúng hành vi của từng route/database.
// Khi lỗi: tên profile lạ làm ứng dụng dừng trước khi mở cổng.
const PROFILES = Object.freeze({
  k67: Object.freeze({
    name: 'k67',
    family: 'k67',
    demoIsolated: false,
    k56PortalPilot: false,
    teacherOptionsMode: 'portal-metadata',
    planningEnabled: true,
    listeningRetakeEnabled: true,
    writingNotifierEnabled: false,
    resultStreamEnabled: false
  }),
  'k56-ic2264': Object.freeze({
    name: 'k56-ic2264',
    family: 'k56',
    demoIsolated: false,
    k56PortalPilot: true,
    teacherOptionsMode: 'legacy-access',
    planningEnabled: false,
    listeningRetakeEnabled: false,
    writingNotifierEnabled: true,
    resultStreamEnabled: true
  }),
  'k56-demo': Object.freeze({
    name: 'k56-demo',
    family: 'k56',
    demoIsolated: true,
    k56PortalPilot: false,
    teacherOptionsMode: 'legacy-access',
    planningEnabled: false,
    listeningRetakeEnabled: false,
    writingNotifierEnabled: true,
    resultStreamEnabled: true
  })
});

export const DEPLOYMENT_PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

export function resolveDeploymentProfile(name = 'k67') {
  const profile = PROFILES[String(name || '').trim()];
  if (!profile) throw new Error('DEPLOYMENT_PROFILE không hợp lệ.');
  return profile;
}

export function profileForConfig(config = {}) {
  return config.deploymentProfile || resolveDeploymentProfile(config.deploymentProfileName || 'k67');
}

export function isK56TestSlug(value) {
  return /^(?:term-test-[1-9][0-9]*-k56|mini-test-k56)$/.test(String(value || ''));
}
