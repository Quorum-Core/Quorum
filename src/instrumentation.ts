// 서버 부팅 훅 — 재시작/재배포 시 진행 중이던(running/finalizing) 회의를 이어서 완주.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // agent_configs는 DB 단독(부트스트랩: sql/agent-configs-seed.sql 1회 실행) — 부팅 시드 없음.
  const { resumeStuckMeetings, resumeStuckDirectives, resumePendingReflections } = await import('@/lib/meeting-runner');
  // 서버 준비 후 1회 스캔(이후 주기 재개는 /api/health 워치독이 담당).
  setTimeout(() => { void resumeStuckMeetings(); void resumeStuckDirectives(); void resumePendingReflections(); }, 5000);
}
